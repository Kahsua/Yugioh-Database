// ============================================================
// SETUP
// ============================================================
const CONFIG = window.YGO_CONFIG || {};
const isConfigured =
  CONFIG.SUPABASE_URL &&
  !CONFIG.SUPABASE_URL.includes("DEIN-PROJEKT") &&
  CONFIG.SUPABASE_ANON_KEY &&
  !CONFIG.SUPABASE_ANON_KEY.includes("DEIN-ANON-KEY");

let supabaseClient = null;
if (isConfigured) {
  supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
} else {
  document.getElementById("config-warning").hidden = false;
}

const YGO_API = "https://db.ygoprodeck.com/api/v7/cardinfo.php";

let currentSession = null;
let currentUsername = null;
let profilesCache = {}; // id -> username

// ============================================================
// HELPERS
// ============================================================
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }

// ============================================================
// ANDROID-"ZURÜCK"-TASTE: Modal schließen statt Seite/App verlassen
// ============================================================
// Beim Öffnen eines Modals legen wir einen zusätzlichen Browser-Verlaufseintrag
// an. Drückt der Nutzer danach "Zurück" (Android-Systemgeste/-Taste), fängt
// der popstate-Event das ab und schließt nur das Modal, statt die App zu
// verlassen. Schließt der Nutzer stattdessen über den X-Button/Klick daneben,
// entfernen wir den Verlaufseintrag sauber wieder per history.back(), damit
// sich keine "leeren" Einträge ansammeln.
let modalHistoryPushed = false;

function pushModalHistory() {
  if (!modalHistoryPushed) {
    modalHistoryPushed = true;
    history.pushState({ ygoModalOpen: true }, "");
  }
}

function hideAllModals() {
  $("#add-modal").classList.add("hidden");
  $("#detail-modal").classList.add("hidden");
}

function closeOpenModal() {
  if (modalHistoryPushed) {
    history.back(); // löst popstate aus, das unten tatsächlich schließt
  } else {
    hideAllModals();
  }
}

window.addEventListener("popstate", () => {
  if (modalHistoryPushed) {
    modalHistoryPushed = false;
    hideAllModals();
  }
});

function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function typeCategory(cardType) {
  if (!cardType) return "monster";
  const t = cardType.toLowerCase();
  if (t.includes("spell") || t.includes("zauber")) return "spell";
  if (t.includes("trap") || t.includes("falle")) return "trap";
  return "monster";
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Supabase/PostgREST liefert standardmäßig max. 1000 Zeilen pro Anfrage.
// Diese Hilfsfunktion holt bei Bedarf mehrere Seiten und fügt sie zusammen,
// damit auch große Sammlungen (>1000 Karten) vollständig geladen werden.
async function fetchAllRows(queryFactory) {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const { data, error } = await queryFactory().range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return { data: all, error: null };
}

async function logHistory(action, cardName, { cardId, qtyBefore, qtyAfter } = {}) {
  if (!supabaseClient || !currentSession) return;
  await supabaseClient.from("history").insert({
    owner_id: currentSession.user.id,
    card_id: cardId ?? null,
    card_name: cardName,
    action,
    quantity_before: qtyBefore ?? null,
    quantity_after: qtyAfter ?? null,
  });
}

// ============================================================
// AUTH SCREEN LOGIC
// ============================================================
$all(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $all(".auth-tab").forEach((b) => b.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    $("#login-form").classList.toggle("hidden", target !== "login");
    $("#signup-form").classList.toggle("hidden", target !== "signup");
  });
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  if (!supabaseClient) return;
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    $("#login-error").textContent = "Anmeldung fehlgeschlagen: " + error.message;
  }
});

$("#signup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#signup-error").textContent = "";
  $("#signup-hint").textContent = "";
  if (!supabaseClient) return;
  const username = $("#signup-username").value.trim();
  const email = $("#signup-email").value.trim();
  const password = $("#signup-password").value;

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });
  if (error) {
    $("#signup-error").textContent = "Registrierung fehlgeschlagen: " + error.message;
    return;
  }

  // Das Profil (Tabelle "profiles") wird automatisch per Datenbank-Trigger
  // angelegt, sobald der Nutzer in auth.users erstellt wird - siehe
  // supabase-schema.sql. Das funktioniert auch, wenn die E-Mail noch
  // nicht bestätigt ist (dann existiert clientseitig noch keine Sitzung).

  if (!data.session) {
    $("#signup-hint").textContent = "Konto erstellt! Bitte bestätige deine E-Mail und melde dich dann an.";
  }
});

$("#logout-btn").addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
});

// ============================================================
// UPDATE ERZWINGEN (v.a. für die installierte App/WebAPK gedacht -
// die prüft viel seltener von selbst auf neue Versionen als ein
// normaler Browser-Tab)
// ============================================================
$("#force-update-btn").addEventListener("click", async () => {
  showToast("Suche nach Updates …");
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    // egal, trotzdem neu laden versuchen
  }
  location.href = location.pathname + "?_fresh=" + Date.now();
});

// ============================================================
// SESSION HANDLING
// ============================================================
async function initSession() {
  if (!supabaseClient) return;
  const { data } = await supabaseClient.auth.getSession();
  await handleSessionChange(data.session);

  supabaseClient.auth.onAuthStateChange(async (_event, session) => {
    await handleSessionChange(session);
  });
}

async function handleSessionChange(session) {
  currentSession = session;
  if (session) {
    await ensureProfileLoaded(session.user.id);
    $("#auth-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#user-label").textContent = currentUsername || session.user.email;
    refreshAllViews();
  } else {
    currentUsername = null;
    $("#app").classList.add("hidden");
    $("#auth-screen").classList.remove("hidden");
  }
}

async function ensureProfileLoaded(userId) {
  const { data } = await supabaseClient.from("profiles").select("id, username").eq("id", userId).maybeSingle();
  if (data) {
    currentUsername = data.username;
    profilesCache[data.id] = data.username;
  }
}

async function loadAllProfiles() {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient.from("profiles").select("id, username");
  if (!error && data) {
    data.forEach((p) => (profilesCache[p.id] = p.username));
  }
}

// ============================================================
// TAB NAVIGATION
// ============================================================
$all(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $all(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    if (view !== "scan") {
      stopScanCamera();
      stopAutoScan();
    }
    $all(".view").forEach((v) => v.classList.remove("active"));
    $("#view-" + view).classList.add("active");
    if (view === "mine") renderMineList();
    if (view === "all") renderAllList();
    if (view === "history") renderHistory();
    if (view === "scan") ensureCardDbLoaded();
    if (view === "collect") {
      refreshMyCardIndex();
      ensureArchetypeListLoaded();
    }
  });
});

function refreshAllViews() {
  refreshMyCardIndex();
  renderMineList();
  renderAllList();
}

// ============================================================
// SEARCH (YGOPRODeck)
// ============================================================
let searchLang = "de";
$all(".lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    $all(".lang-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    searchLang = btn.dataset.lang;
    const q = $("#search-input").value.trim();
    if (q.length >= 3) runSearch(q);
  });
});

$("#search-input").addEventListener(
  "input",
  debounce((e) => {
    const q = e.target.value.trim();
    if (q.length < 3) {
      $("#search-results").innerHTML = "";
      $("#search-status").textContent = "";
      return;
    }
    runSearch(q);
  }, 400)
);

$("#archetype-search-btn").addEventListener("click", () => {
  const val = $("#archetype-search-input").value.trim();
  if (val) runArchetypeSearch(val, "#search-status", "#search-results");
});
$("#archetype-search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#archetype-search-btn").click();
});

async function fetchYgo(query, lang) {
  let url = `${YGO_API}?fname=${encodeURIComponent(query)}&num=20&offset=0`;
  if (lang === "de") url += "&language=de";
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch {
    return [];
  }
}

// Wie fetchYgo, aber filtert nach Archetyp statt nach Namen.
async function fetchYgoByArchetype(archetype, lang) {
  let url = `${YGO_API}?archetype=${encodeURIComponent(archetype)}&num=100&offset=0`;
  if (lang === "de") url += "&language=de";
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch {
    return [];
  }
}

// Holt gezielt bestimmte Karten per ID (statt per Namenssuche) - genutzt, um
// die jeweils fehlende Sprache nachzuladen, wenn eine Karte nur in einer
// Sprache gefunden wurde (siehe mergeDualLanguageResults).
async function fetchByIds(ids, lang) {
  if (!ids || ids.length === 0) return [];
  let url = `${YGO_API}?id=${ids.join(",")}`;
  if (lang === "de") url += "&language=de";
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch {
    return [];
  }
}

// Führt deutsche und englische Suchergebnisse zu einer gemeinsamen Liste
// zusammen. Wichtig: Wenn z.B. ein deutscher Name/Archetyp eingegeben wird,
// findet die englische Suche mit demselben Text normalerweise NICHTS (andere
// Sprache!) - das bedeutet nicht, dass die Karte keinen englischen Namen hat,
// nur dass die Suche in der falschen Sprache lief. Das wird unten per
// gezielter ID-Abfrage nachgeholt. Wird sowohl von der Namens- als auch der
// Archetyp-Suche genutzt.
async function mergeDualLanguageResults(deResults, enResults) {
  const byId = new Map();
  enResults.forEach((c) => byId.set(c.id, { en: c, de: null }));
  deResults.forEach((c) => {
    if (byId.has(c.id)) byId.get(c.id).de = c;
    else byId.set(c.id, { en: null, de: c });
  });

  const missingDeIds = [];
  const missingEnIds = [];
  byId.forEach((v, id) => {
    if (!v.de) missingDeIds.push(id);
    if (!v.en) missingEnIds.push(id);
  });
  if (missingDeIds.length > 0 || missingEnIds.length > 0) {
    const [fetchedDe, fetchedEn] = await Promise.all([
      fetchByIds(missingDeIds, "de"),
      fetchByIds(missingEnIds, "en"),
    ]);
    fetchedDe.forEach((c) => {
      if (byId.has(c.id)) byId.get(c.id).de = c;
    });
    fetchedEn.forEach((c) => {
      if (byId.has(c.id)) byId.get(c.id).en = c;
    });
  }

  return Array.from(byId.values()).map(({ en, de }) => {
    const canonical = en || de; // englische Version bevorzugt für Typ/Werte
    return {
      id: canonical.id,
      name_en: en ? en.name : canonical.name,
      name_de: de ? de.name : null,
      type: canonical.type,
      race: canonical.race,
      attribute: canonical.attribute,
      atk: canonical.atk,
      def: canonical.def,
      level: canonical.level ?? canonical.linkval,
      archetype: canonical.archetype || null,
      scale: canonical.scale ?? null,
      desc_de: de ? de.desc : null,
      desc_en: en ? en.desc : null,
      image: canonical.card_images && canonical.card_images[0] ? canonical.card_images[0].image_url : "",
    };
  });
}

async function runSearch(query, statusSel, resultsSel) {
  statusSel = statusSel || "#search-status";
  resultsSel = resultsSel || "#search-results";
  $(statusSel).textContent = "Suche läuft …";
  $(resultsSel).innerHTML = "";

  const [deResults, enResults] = await Promise.all([
    fetchYgo(query, "de"),
    fetchYgo(query, "en"),
  ]);
  const merged = await mergeDualLanguageResults(deResults, enResults);

  if (merged.length === 0) {
    $(statusSel).textContent = "Keine Karten gefunden.";
    return;
  }
  $(statusSel).textContent = `${merged.length} Treffer`;
  renderSearchResults(merged, resultsSel);
}

async function runArchetypeSearch(archetype, statusSel, resultsSel) {
  statusSel = statusSel || "#search-status";
  resultsSel = resultsSel || "#search-results";
  $(statusSel).textContent = "Suche läuft …";
  $(resultsSel).innerHTML = "";

  const [deResults, enResults] = await Promise.all([
    fetchYgoByArchetype(archetype, "de"),
    fetchYgoByArchetype(archetype, "en"),
  ]);
  const merged = await mergeDualLanguageResults(deResults, enResults);

  if (merged.length === 0) {
    $(statusSel).textContent = `Keine Karten für den Archetyp "${archetype}" gefunden.`;
    return;
  }
  $(statusSel).textContent = `${merged.length} Karten im Archetyp "${archetype}"`;
  renderSearchResults(merged, resultsSel);
}

// ============================================================
// ARCHETYP-LISTE (für die Autovervollständigung bei der Archetyp-Suche)
// ============================================================
let archetypeListCache = null;

async function ensureArchetypeListLoaded() {
  if (archetypeListCache) return archetypeListCache;
  try {
    const res = await fetch("https://db.ygoprodeck.com/api/v7/archetypes.php");
    const json = await res.json();
    archetypeListCache = (json || [])
      .map((a) => a.archetype_name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    archetypeListCache = [];
  }
  populateDatalist("#archetype-datalist", archetypeListCache);
  return archetypeListCache;
}

function populateDatalist(selector, values) {
  const dl = $(selector);
  if (!dl) return;
  dl.innerHTML = values.map((v) => `<option value="${v.replace(/"/g, "&quot;")}"></option>`).join("");
}

// ============================================================
// EIGENE SAMMLUNG ALS INDEX (für "bereits vorhanden"-Anzeige und
// Dubletten-Schutz beim manuellen Hinzufügen)
// ============================================================
let myCardIndexByYgoId = new Map(); // ygo_id -> { id, quantity }

async function refreshMyCardIndex() {
  if (!supabaseClient || !currentSession) return;
  const { data } = await fetchAllRows(() =>
    supabaseClient
      .from("cards")
      .select("id, ygo_id, quantity")
      .eq("owner_id", currentSession.user.id)
      .not("ygo_id", "is", null)
      .order("id", { ascending: true })
  );
  myCardIndexByYgoId = new Map((data || []).map((c) => [c.ygo_id, { id: c.id, quantity: c.quantity }]));
}

function renderSearchResults(cards, resultsSel) {
  const grid = $(resultsSel || "#search-results");
  grid.innerHTML = "";
  cards.forEach((card) => {
    const owned = myCardIndexByYgoId.get(card.id);
    const el = document.createElement("div");
    el.className = "result-card";
    el.innerHTML = `
      <img src="${card.image}" alt="${card.name_en}" loading="lazy" />
      ${owned ? `<span class="result-card-owned">Bereits ×${owned.quantity}</span>` : ""}
      <div class="result-card-body">
        <div class="result-card-name">${card.name_de || card.name_en}</div>
        ${card.name_de ? `<div class="result-card-name-en">${card.name_en}</div>` : ""}
      </div>
    `;
    el.addEventListener("click", () => openAddModal(card));
    grid.appendChild(el);
  });
}

// ============================================================
// ADD MODAL
// ============================================================
let modalCard = null;

function openAddModal(card) {
  modalCard = card;
  $("#modal-img").src = card.image;
  $("#modal-name-de").textContent = card.name_de || card.name_en;
  $("#modal-name-en").textContent = card.name_de ? card.name_en : "";
  $("#modal-type-badge").textContent = card.type || "";

  const stats = [];
  if (card.attribute) stats.push(card.attribute);
  if (card.race) stats.push(card.race);
  if (card.level) stats.push(`Lvl/Rank ${card.level}`);
  if (card.atk != null) stats.push(`ATK ${card.atk}`);
  if (card.def != null) stats.push(`DEF ${card.def}`);
  $("#modal-stats").innerHTML = stats.map((s) => `<span>${s}</span>`).join("");
  $("#modal-desc-de").textContent = card.desc_de || "Kein deutscher Kartentext verfügbar.";
  $("#modal-desc-en").textContent = card.desc_en || "No English card text available.";
  $("#modal-qty").value = 1;
  $("#modal-msg").textContent = "";

  const owned = myCardIndexByYgoId.get(card.id);
  const ownedInfo = $("#modal-owned-info");
  if (owned) {
    ownedInfo.textContent = `Du hast bereits ${owned.quantity}× diese Karte in deiner Sammlung - die neue Anzahl wird addiert.`;
    ownedInfo.classList.remove("hidden");
  } else {
    ownedInfo.classList.add("hidden");
  }

  $("#add-modal").classList.remove("hidden");
  pushModalHistory();
}

$("#modal-close").addEventListener("click", closeOpenModal);
$("#add-modal").addEventListener("click", (e) => {
  if (e.target.id === "add-modal") closeOpenModal();
});

$("#modal-save").addEventListener("click", async () => {
  if (!modalCard || !currentSession) return;
  const qty = parseInt($("#modal-qty").value, 10) || 1;
  const btn = $("#modal-save");
  btn.disabled = true;

  // Immer frisch (nicht nur aus dem Cache) prüfen, ob diese Karte per YGO-ID
  // bereits existiert - das verhindert Dubletten, egal ob die Karte vorher per
  // CSV-Import oder manuell angelegt wurde.
  const { data: existingByIdRows } = await supabaseClient
    .from("cards")
    .select("id, quantity")
    .eq("owner_id", currentSession.user.id)
    .eq("ygo_id", modalCard.id)
    .limit(1);
  let existing = existingByIdRows && existingByIdRows[0];

  // Zusatz-Sicherheitsnetz: Karten aus dem CSV-Import, die dort keinen
  // automatischen Treffer hatten, haben keine ygo_id. Über den Namen
  // trotzdem abgleichen, damit auch die nicht doppelt angelegt werden.
  if (!existing) {
    const { data: nameRows } = await supabaseClient
      .from("cards")
      .select("id, quantity, name_de, name_en")
      .eq("owner_id", currentSession.user.id)
      .is("ygo_id", null);
    const nameDe = (modalCard.name_de || "").toLowerCase();
    const nameEn = (modalCard.name_en || "").toLowerCase();
    existing = (nameRows || []).find(
      (r) => (r.name_de && r.name_de.toLowerCase() === nameDe) || (r.name_en && r.name_en.toLowerCase() === nameEn)
    );
  }

  let error;
  if (existing) {
    const newQty = existing.quantity + qty;
    ({ error } = await supabaseClient
      .from("cards")
      .update({
        quantity: newQty,
        ygo_id: modalCard.id, // jetzt sicher bekannt, ggf. nachtragen
        // Name/Typ/Werte werden bei jedem erneuten Hinzufügen aufgefrischt -
        // behebt u.a. Fälle, in denen die Karte zuvor nur mit einer Sprache
        // gespeichert wurde (siehe runSearch-Fix) und jetzt vervollständigt wird.
        name_de: modalCard.name_de || null,
        name_en: modalCard.name_en,
        card_type: modalCard.type,
        attribute: modalCard.attribute,
        race: modalCard.race,
        atk: modalCard.atk,
        def: modalCard.def,
        level: modalCard.level,
        image_url: modalCard.image,
        effect_text_de: modalCard.desc_de || null,
        effect_text_en: modalCard.desc_en || null,
        archetype: modalCard.archetype || null,
        scale: modalCard.scale ?? null,
      })
      .eq("id", existing.id));
    if (!error) {
      logHistory("update", modalCard.name_de || modalCard.name_en, {
        cardId: existing.id,
        qtyBefore: existing.quantity,
        qtyAfter: newQty,
      });
      $("#modal-msg").style.color = "var(--spell)";
      $("#modal-msg").textContent = `War bereits vorhanden - Anzahl aktualisiert: ${existing.quantity} → ${newQty}`;
      showToast(`Anzahl aktualisiert: ${newQty}× "${modalCard.name_de || modalCard.name_en}"`);
    }
  } else {
    ({ error } = await supabaseClient.from("cards").insert({
      owner_id: currentSession.user.id,
      ygo_id: modalCard.id,
      name_de: modalCard.name_de,
      name_en: modalCard.name_en,
      card_type: modalCard.type,
      attribute: modalCard.attribute,
      race: modalCard.race,
      atk: modalCard.atk,
      def: modalCard.def,
      level: modalCard.level,
      image_url: modalCard.image,
      quantity: qty,
      effect_text_de: modalCard.desc_de || null,
      effect_text_en: modalCard.desc_en || null,
      archetype: modalCard.archetype || null,
      scale: modalCard.scale ?? null,
    }));
    if (!error) {
      $("#modal-msg").style.color = "var(--spell)";
      $("#modal-msg").textContent = "Zur Sammlung hinzugefügt!";
      showToast(`${qty}× "${modalCard.name_de || modalCard.name_en}" gespeichert`);
      logHistory("add", modalCard.name_de || modalCard.name_en, { qtyAfter: qty });
    }
  }

  btn.disabled = false;
  if (error) {
    $("#modal-msg").style.color = "var(--danger)";
    $("#modal-msg").textContent = "Fehler: " + error.message;
    return;
  }

  await refreshMyCardIndex();
  renderMineList();
  renderAllList();
  setTimeout(closeOpenModal, 700);
});

// ============================================================
// MEINE SAMMLUNG
// ============================================================
async function renderMineList() {
  if (!supabaseClient || !currentSession) return;
  const { data, error } = await fetchAllRows(() =>
    supabaseClient.from("cards").select("*").eq("owner_id", currentSession.user.id).order("created_at", { ascending: false }).order("id", { ascending: false })
  );

  if (error) {
    $("#mine-list").innerHTML = `<div class="empty-state">Fehler beim Laden: ${error.message}</div>`;
    return;
  }

  populateFilterOptions("#mine-attribute-filter", data, "attribute");
  populateFilterOptionsByCategory("#mine-monster-type-filter", data, "monster", "Monstertyp …");
  populateFilterOptionsByCategory("#mine-spell-type-filter", data, "spell", "Zaubertyp …");
  populateFilterOptionsByCategory("#mine-trap-type-filter", data, "trap", "Fallentyp …");
  populateDatalistFromField("#mine-archetype-datalist", data, "archetype");

  const filtered = applyFilters(data, {
    text: $("#mine-filter").value,
    category: $("#mine-category-filter").value,
    attribute: $("#mine-attribute-filter").value,
    monsterType: $("#mine-monster-type-filter").value,
    spellType: $("#mine-spell-type-filter").value,
    trapType: $("#mine-trap-type-filter").value,
    archetype: $("#mine-archetype-filter").value,
  });

  const totalCount = data.reduce((sum, c) => sum + c.quantity, 0);
  $("#mine-count").textContent = `${data.length} Karten · ${totalCount} Exemplare`;

  renderCardList("#mine-list", filtered, { showOwner: false, editable: true });
}

$("#mine-filter").addEventListener("input", debounce(renderMineList, 200));
$("#mine-category-filter").addEventListener("change", renderMineList);
$("#mine-attribute-filter").addEventListener("change", renderMineList);
$("#mine-archetype-filter").addEventListener("input", debounce(renderMineList, 200));
[
  ["#mine-monster-type-filter", "#mine-spell-type-filter", "#mine-trap-type-filter"],
].forEach((group) => wireExclusiveTypeFilters(group, renderMineList));

// ============================================================
// ALLE SAMMLUNGEN
// ============================================================
async function renderAllList() {
  if (!supabaseClient) return;
  await loadAllProfiles();

  const { data, error } = await fetchAllRows(() =>
    supabaseClient.from("cards").select("*").order("created_at", { ascending: false }).order("id", { ascending: false })
  );

  if (error) {
    $("#all-list").innerHTML = `<div class="empty-state">Fehler beim Laden: ${error.message}</div>`;
    return;
  }

  // Besitzer-Dropdown befüllen
  const ownerSelect = $("#all-owner-filter");
  const currentSelection = ownerSelect.value;
  const uniqueOwners = [...new Set(data.map((c) => c.owner_id))];
  ownerSelect.innerHTML =
    `<option value="">Alle Besitzer</option>` +
    uniqueOwners
      .map((id) => `<option value="${id}">${profilesCache[id] || "Unbekannt"}</option>`)
      .join("");
  ownerSelect.value = currentSelection;

  populateFilterOptions("#all-attribute-filter", data, "attribute");
  populateFilterOptionsByCategory("#all-monster-type-filter", data, "monster", "Monstertyp …");
  populateFilterOptionsByCategory("#all-spell-type-filter", data, "spell", "Zaubertyp …");
  populateFilterOptionsByCategory("#all-trap-type-filter", data, "trap", "Fallentyp …");
  populateDatalistFromField("#all-archetype-datalist", data, "archetype");

  const filtered = applyFilters(data, {
    text: $("#all-filter").value,
    category: $("#all-category-filter").value,
    attribute: $("#all-attribute-filter").value,
    monsterType: $("#all-monster-type-filter").value,
    spellType: $("#all-spell-type-filter").value,
    trapType: $("#all-trap-type-filter").value,
    archetype: $("#all-archetype-filter").value,
    owner: ownerSelect.value,
  });

  const totalCount = filtered.reduce((sum, c) => sum + c.quantity, 0);
  $("#all-count").textContent = `${filtered.length} Karten · ${totalCount} Exemplare`;

  renderCardList("#all-list", filtered, { showOwner: true, editable: false });
}

$("#all-filter").addEventListener("input", debounce(renderAllList, 200));
$("#all-archetype-filter").addEventListener("input", debounce(renderAllList, 200));
["#all-owner-filter", "#all-category-filter", "#all-attribute-filter"].forEach((sel) =>
  $(sel).addEventListener("change", renderAllList)
);
wireExclusiveTypeFilters(["#all-monster-type-filter", "#all-spell-type-filter", "#all-trap-type-filter"], renderAllList);

// ============================================================
// FILTER-HELFER
// ============================================================
function populateFilterOptions(selectSel, data, field) {
  const select = $(selectSel);
  const current = select.value;
  const values = [...new Set(data.map((c) => c[field]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "de")
  );
  const placeholder = select.options[0]; // erste Option (z.B. "Alle Attribute") behalten
  select.innerHTML = "";
  select.appendChild(placeholder);
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
  select.value = current;
}

// Befüllt ein Typ-Dropdown nur mit den "race"-Werten, die innerhalb EINER
// Kategorie vorkommen (z.B. nur Monstertypen wie Krieger/Magier/Drache,
// nicht vermischt mit Zauber-/Fallen-Unterarten).
function populateFilterOptionsByCategory(selectSel, data, category, placeholderText) {
  const select = $(selectSel);
  const current = select.value;
  const values = [
    ...new Set(data.filter((c) => typeCategory(c.card_type) === category).map((c) => c.race).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b, "de"));
  select.innerHTML = `<option value="">${placeholderText}</option>`;
  values.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    select.appendChild(opt);
  });
  select.value = current;
}

// Befüllt ein <datalist> mit den eindeutigen Werten eines Feldes (z.B.
// Archetypen), die in den Daten tatsächlich vorkommen - für Freitextfelder
// mit Autovervollständigung.
function populateDatalistFromField(datalistSel, data, field) {
  const values = [...new Set(data.map((c) => c[field]).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
  populateDatalist(datalistSel, values);
}

// Die drei Typ-Dropdowns (Monster/Zauber/Falle) schließen sich gegenseitig aus:
// Wählt man in einem einen Wert, werden die beiden anderen zurückgesetzt.
function wireExclusiveTypeFilters(selectors, onChange) {
  selectors.forEach((sel) => {
    $(sel).addEventListener("change", () => {
      if ($(sel).value) {
        selectors.filter((s) => s !== sel).forEach((s) => ($(s).value = ""));
      }
      onChange();
    });
  });
}

function applyFilters(data, { text, category, attribute, monsterType, spellType, trapType, archetype, owner }) {
  const textVal = (text || "").toLowerCase();
  const archetypeVal = (archetype || "").toLowerCase();
  return data.filter((c) => {
    const cat = typeCategory(c.card_type);
    const matchesText =
      !textVal ||
      (c.name_de || "").toLowerCase().includes(textVal) ||
      (c.name_en || "").toLowerCase().includes(textVal) ||
      (c.archetype || "").toLowerCase().includes(textVal);
    const matchesCategory = !category || cat === category;
    const matchesAttribute = !attribute || c.attribute === attribute;
    const matchesMonsterType = !monsterType || (cat === "monster" && c.race === monsterType);
    const matchesSpellType = !spellType || (cat === "spell" && c.race === spellType);
    const matchesTrapType = !trapType || (cat === "trap" && c.race === trapType);
    const matchesArchetype = !archetypeVal || (c.archetype || "").toLowerCase().includes(archetypeVal);
    const matchesOwner = !owner || c.owner_id === owner;
    return (
      matchesText &&
      matchesCategory &&
      matchesAttribute &&
      matchesMonsterType &&
      matchesSpellType &&
      matchesTrapType &&
      matchesArchetype &&
      matchesOwner
    );
  });
}

// ============================================================
// GEMEINSAME LISTEN-RENDERFUNKTION
// ============================================================
function renderCardList(containerSel, cards, { showOwner, editable }) {
  const container = $(containerSel);
  container.innerHTML = "";

  if (cards.length === 0) {
    container.innerHTML = `<div class="empty-state">Keine Karten gefunden.</div>`;
    return;
  }

  cards.forEach((card) => {
    const cat = typeCategory(card.card_type);
    const row = document.createElement("div");
    row.className = `card-row type-${cat}`;

    const statBits = [];
    if (card.attribute) statBits.push(card.attribute);
    if (card.level) statBits.push(`Lvl ${card.level}`);
    if (card.atk != null) statBits.push(`<span class="stat">ATK ${card.atk}</span>`);
    if (card.def != null) statBits.push(`<span class="stat">DEF ${card.def}</span>`);

    row.innerHTML = `
      <img src="${card.image_url || ""}" alt="" loading="lazy" />
      <div class="card-row-main">
        <div class="card-row-name">${card.name_de || card.name_en}</div>
        <div class="card-row-meta">
          <span>${card.card_type || ""}</span>
          ${statBits.map((s) => `<span>${s}</span>`).join("")}
        </div>
      </div>
      <div class="card-row-trailing">
        ${showOwner ? `<span class="card-row-owner">${profilesCache[card.owner_id] || "Unbekannt"}</span>` : ""}
        <span class="card-row-qty">×${card.quantity}</span>
        ${
          editable
            ? `<div class="card-row-actions">
                 <button class="icon-btn" data-action="dec" title="Anzahl verringern">−</button>
                 <button class="icon-btn" data-action="inc" title="Anzahl erhöhen">+</button>
                 <button class="icon-btn danger" data-action="del" title="Löschen">🗑</button>
               </div>`
            : ""
        }
      </div>
    `;

    if (editable) {
      row.querySelector('[data-action="inc"]').addEventListener("click", (e) => {
        e.stopPropagation();
        updateQty(card, card.quantity + 1);
      });
      row.querySelector('[data-action="dec"]').addEventListener("click", (e) => {
        e.stopPropagation();
        if (card.quantity <= 1) return deleteCard(card);
        updateQty(card, card.quantity - 1);
      });
      row.querySelector('[data-action="del"]').addEventListener("click", (e) => {
        e.stopPropagation();
        deleteCard(card);
      });
    }

    row.addEventListener("click", () => openDetailModal(card, editable));

    container.appendChild(row);
  });
}

async function updateQty(card, newQty) {
  const { error } = await supabaseClient.from("cards").update({ quantity: newQty }).eq("id", card.id);
  if (error) return showToast("Fehler: " + error.message);
  logHistory("update", card.name_de || card.name_en, { cardId: card.id, qtyBefore: card.quantity, qtyAfter: newQty });
  await refreshMyCardIndex();
  renderMineList();
  renderAllList();
}

async function deleteCard(card) {
  const { error } = await supabaseClient.from("cards").delete().eq("id", card.id);
  if (error) return showToast("Fehler: " + error.message);
  showToast(`"${card.name_de || card.name_en}" entfernt`);
  logHistory("delete", card.name_de || card.name_en, { qtyBefore: card.quantity });
  await refreshMyCardIndex();
  renderMineList();
  renderAllList();
}

// ============================================================
// DETAIL-MODAL (alle Infos zu einer Karte in der Sammlung)
// ============================================================
let detailCard = null;

function openDetailModal(card, editable) {
  detailCard = card;
  $("#detail-img").src = card.image_url || "";
  $("#detail-name-de").textContent = card.name_de || card.name_en;
  $("#detail-name-en").textContent = card.name_de && card.name_de !== card.name_en ? card.name_en : "";
  $("#detail-type-badge").textContent = card.card_type || "";

  const stats = [];
  if (card.attribute) stats.push(card.attribute);
  if (card.race) stats.push(card.race);
  if (card.archetype) stats.push(`Archetyp: ${card.archetype}`);
  if (card.level) stats.push(`Lvl/Rang/Link ${card.level}`);
  if (card.scale != null) stats.push(`Pendel-Skala ${card.scale}`);
  if (card.atk != null) stats.push(`ATK ${card.atk}`);
  if (card.def != null) stats.push(`DEF ${card.def}`);
  $("#detail-stats").innerHTML = stats.map((s) => `<span>${s}</span>`).join("");

  $("#detail-desc-de").textContent = card.effect_text_de || "Kein deutscher Kartentext hinterlegt.";
  $("#detail-desc-en").textContent = card.effect_text_en || "No English card text available.";

  $("#detail-owner").textContent = profilesCache[card.owner_id] ? "Besitzer: " + profilesCache[card.owner_id] : "";
  $("#detail-owner").style.display = profilesCache[card.owner_id] ? "inline-block" : "none";
  $("#detail-qty").textContent = `×${card.quantity}`;

  const editRow = $("#detail-edit-row");
  editRow.classList.toggle("hidden", !editable);
  if (editable) {
    editRow.querySelector('[data-action="inc"]').onclick = () => {
      updateQty(card, card.quantity + 1);
      closeOpenModal();
    };
    editRow.querySelector('[data-action="dec"]').onclick = () => {
      if (card.quantity <= 1) deleteCard(card);
      else updateQty(card, card.quantity - 1);
      closeOpenModal();
    };
    editRow.querySelector('[data-action="del"]').onclick = () => {
      deleteCard(card);
      closeOpenModal();
    };
  }

  $("#detail-modal").classList.remove("hidden");
  pushModalHistory();
}

$("#detail-modal-close").addEventListener("click", closeOpenModal);
$("#detail-modal").addEventListener("click", (e) => {
  if (e.target.id === "detail-modal") closeOpenModal();
});

// ============================================================
// VERLAUF
// ============================================================
const HISTORY_LABELS = {
  add: { icon: "＋", label: "Hinzugefügt" },
  update: { icon: "✎", label: "Anzahl geändert" },
  delete: { icon: "🗑", label: "Entfernt" },
  import: { icon: "⇪", label: "Import" },
};

async function renderHistory() {
  if (!supabaseClient) return;
  await loadAllProfiles();

  const { data, error } = await fetchAllRows(() =>
    supabaseClient.from("history").select("*").order("created_at", { ascending: false }).order("id", { ascending: false })
  );

  if (error) {
    $("#history-list").innerHTML = `<div class="empty-state">Fehler beim Laden: ${error.message}</div>`;
    return;
  }

  const ownerSelect = $("#history-owner-filter");
  const currentSelection = ownerSelect.value;
  const uniqueOwners = [...new Set(data.map((h) => h.owner_id))];
  ownerSelect.innerHTML =
    `<option value="">Alle Personen</option>` +
    uniqueOwners.map((id) => `<option value="${id}">${profilesCache[id] || "Unbekannt"}</option>`).join("");
  ownerSelect.value = currentSelection;

  const filtered = ownerSelect.value ? data.filter((h) => h.owner_id === ownerSelect.value) : data;
  $("#history-count").textContent = `${filtered.length} Einträge`;

  const container = $("#history-list");
  container.innerHTML = "";
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">Noch keine Änderungen protokolliert.</div>`;
    return;
  }

  filtered.forEach((h) => {
    const meta = HISTORY_LABELS[h.action] || { icon: "•", label: h.action };
    let detail = meta.label;
    if (h.action === "update") detail = `Anzahl: ${h.quantity_before} → ${h.quantity_after}`;
    else if (h.action === "add") detail = `Hinzugefügt (${h.quantity_after}×)`;
    else if (h.action === "delete") detail = `Entfernt (war ${h.quantity_before}×)`;

    const row = document.createElement("div");
    row.className = "history-row";
    row.innerHTML = `
      <div class="history-icon ${h.action}">${meta.icon}</div>
      <div class="history-main">
        <div class="history-title">${h.card_name}</div>
        <div class="history-meta">${profilesCache[h.owner_id] || "Unbekannt"} · ${detail}</div>
      </div>
      <div class="history-time">${formatDateTime(h.created_at)}</div>
    `;
    container.appendChild(row);
  });
}

$("#history-owner-filter").addEventListener("change", renderHistory);

function formatDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ============================================================
// IMPORT (bestehende Excel/CSV-Sammlung)
// ============================================================
let importRows = null;
let importCancelled = false;

$("#import-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $("#file-drop-label").textContent = file.name;
  $("#import-results").classList.add("hidden");
  $("#import-confirm").classList.add("hidden");
  pendingImport = null;

  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    encoding: "UTF-8",
    complete: (results) => {
      importRows = results.data.filter((r) => (r.Deutsch || r.Englisch));
      $("#import-start-btn").disabled = importRows.length === 0;
      $("#import-status").textContent = "";
      if (importRows.length === 0) {
        $("#file-drop-label").textContent = "Keine gültigen Zeilen gefunden – bitte Datei prüfen.";
      } else {
        $("#file-drop-label").textContent = `${file.name} (${importRows.length} Karten erkannt)`;
      }
    },
    error: (err) => {
      $("#file-drop-label").textContent = "Fehler beim Lesen: " + err.message;
    },
  });
});

function normalizeName(s) {
  return (s || "").toString().trim().toLowerCase();
}

// Die komplette Datenbank ist ~20 MB pro Sprache - deshalb im Browser
// zwischenspeichern (Cache API) statt bei jedem Start neu zu laden.
// Nach CARD_DB_MAX_AGE_MS wird neu geladen (neue Karten); ohne Netz wird
// notfalls auch eine ältere Kopie verwendet.
const CARD_DB_CACHE = "ygo-carddb-v1";
const CARD_DB_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

async function fetchFullYgoDatabase(lang) {
  let url = YGO_API;
  if (lang === "de") url += "?language=de";

  let cache = null;
  let cached = null;
  try {
    cache = await caches.open(CARD_DB_CACHE);
    cached = await cache.match(url);
  } catch (err) {
    // Cache API nicht verfügbar (z.B. kein https) - einfach direkt laden
  }
  const cachedAt = cached ? Number(cached.headers.get("x-cached-at")) || 0 : 0;
  if (cached && Date.now() - cachedAt < CARD_DB_MAX_AGE_MS) {
    try {
      return (await cached.clone().json()).data || [];
    } catch (err) {
      // beschädigter Eintrag - neu laden
    }
  }

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("YGOPRODeck-Datenbank konnte nicht geladen werden");
    const text = await res.text();
    if (cache) {
      cache
        .put(url, new Response(text, { headers: { "content-type": "application/json", "x-cached-at": String(Date.now()) } }))
        .catch(() => {});
    }
    return JSON.parse(text).data || [];
  } catch (err) {
    if (cached) return (await cached.json()).data || [];
    throw err;
  }
}

$("#import-start-btn").addEventListener("click", runImport);
$("#import-cancel-btn").addEventListener("click", () => {
  importCancelled = true;
});

let pendingImport = null; // { toInsert, toUpdate, notFound }

async function runImport() {
  if (!importRows || !currentSession) return;
  importCancelled = false;
  $("#import-start-btn").disabled = true;
  $("#import-cancel-btn").classList.remove("hidden");
  $("#import-progress-wrap").classList.remove("hidden");
  $("#import-results").classList.add("hidden");
  $("#import-confirm").classList.add("hidden");
  const statusEl = $("#import-status");
  const fillEl = $("#import-progress-fill");

  try {
    // Schritt 1: komplette Kartendatenbank einmalig laden (EN = kanonische Werte + Bild, DE = deutsche Namen)
    statusEl.textContent = "Lade komplette Kartendatenbank von YGOPRODeck (einmalig, ca. 10–20 Sek.) …";
    fillEl.style.width = "5%";
    const [enCards, deCards] = await Promise.all([
      fetchFullYgoDatabase("en"),
      fetchFullYgoDatabase("de"),
    ]);

    const enById = new Map();
    const enByName = new Map();
    enCards.forEach((c) => {
      enById.set(c.id, c);
      enByName.set(normalizeName(c.name), c);
    });
    const deById = new Map();
    const deIdByName = new Map();
    deCards.forEach((c) => {
      deById.set(c.id, c);
      deIdByName.set(normalizeName(c.name), c.id);
    });

    fillEl.style.width = "15%";

    // Schritt 2: bereits vorhandene Karten des Nutzers laden (mit Pagination,
    // damit auch Sammlungen >1000 Karten vollständig geprüft werden), um
    // Duplikate zu erkennen und Anzahl/fehlende Infos zu aktualisieren
    statusEl.textContent = "Prüfe vorhandene Sammlung …";
    const { data: existingCards } = await fetchAllRows(() =>
      supabaseClient
        .from("cards")
        .select("id, ygo_id, name_de, name_en, quantity, effect_text_de, effect_text_en")
        .eq("owner_id", currentSession.user.id)
        .order("id", { ascending: true })
    );
    const existingByKey = new Map(
      (existingCards || []).map((c) => [
        c.ygo_id ? "id:" + c.ygo_id : "name:" + normalizeName(c.name_de || c.name_en),
        c,
      ])
    );

    // Schritt 3: jede Zeile matchen (nur analysieren, noch NICHTS speichern)
    const toInsert = [];
    const toUpdate = [];
    const notFound = [];

    for (let i = 0; i < importRows.length; i++) {
      if (importCancelled) break;
      const row = importRows[i];
      const deName = normalizeName(row.Deutsch);
      const enNameRaw = row.Englisch;
      let matched = null;

      if (deIdByName.has(deName)) {
        matched = enById.get(deIdByName.get(deName));
      }
      if (!matched && enByName.has(normalizeName(enNameRaw))) {
        matched = enByName.get(normalizeName(enNameRaw));
      }

      const qty = parseInt(row.Anzahl, 10) || 1;
      const cardTypeLabel = [row.Kartenart, row.Kartentyp].filter(Boolean).join(" – ");

      const key = matched ? "id:" + matched.id : "name:" + deName;
      const existing = existingByKey.get(key);
      const deMatch = matched ? deById.get(matched.id) : null;

      if (existing) {
        // Karte bereits vorhanden: Anzahl aufaddieren statt zu überspringen,
        // dabei gleich fehlende Zusatzinfos (Kartentext UND fehlende Namen in
        // einer Sprache - kann durch einen früheren Suche-Bug entstanden sein)
        // mit nachtragen
        const missingDe = !existing.effect_text_de && deMatch && deMatch.desc;
        const missingEn = !existing.effect_text_en && matched && matched.desc;
        toUpdate.push({
          id: existing.id,
          name: existing.name_de || existing.name_en,
          qtyBefore: existing.quantity,
          qtyAdd: qty,
          qtyAfter: existing.quantity + qty,
          name_de: existing.name_de || (deMatch ? deMatch.name : null),
          name_en: existing.name_en || (matched ? matched.name : null),
          effect_text_de: missingDe ? deMatch.desc : existing.effect_text_de,
          effect_text_en: missingEn ? matched.desc : existing.effect_text_en,
          archetype: matched ? matched.archetype || null : null,
          scale: matched ? matched.scale ?? null : null,
          image_url: matched && matched.card_images && matched.card_images[0] ? matched.card_images[0].image_url : null,
          ygo_id: matched ? matched.id : existing.ygo_id,
        });
        continue;
      }

      const atkVal = parseIntOrNull(row.ATK);
      const defVal = parseIntOrNull(row.DEF);
      const levelVal = parseIntOrNull(row.Stufe_Rang_Link);

      toInsert.push({
        owner_id: currentSession.user.id,
        ygo_id: matched ? matched.id : null,
        name_de: row.Deutsch || null,
        name_en: row.Englisch || (matched ? matched.name : row.Deutsch),
        card_type: cardTypeLabel || (matched ? matched.type : null),
        attribute: row.Eigenschaft && row.Eigenschaft !== "-" ? row.Eigenschaft : (matched ? matched.attribute : null),
        race: row.Typ && row.Typ !== "-" ? row.Typ : (matched ? matched.race : null),
        atk: atkVal,
        def: defVal,
        level: levelVal,
        image_url: matched && matched.card_images && matched.card_images[0] ? matched.card_images[0].image_url : null,
        quantity: qty,
        effect_text_de: deMatch ? deMatch.desc : null,
        effect_text_en: matched ? matched.desc : null,
        archetype: matched ? matched.archetype || null : null,
        scale: matched ? matched.scale ?? null : null,
      });

      if (!matched) notFound.push(row.Deutsch || row.Englisch);

      if (i % 50 === 0) {
        const pct = 15 + Math.round((i / importRows.length) * 70);
        fillEl.style.width = pct + "%";
        statusEl.textContent = `Gleiche Karten ab … (${i}/${importRows.length})`;
        await new Promise((r) => setTimeout(r, 0)); // UI nicht blockieren
      }
    }

    if (importCancelled) {
      statusEl.textContent = "Import abgebrochen.";
      $("#import-cancel-btn").classList.add("hidden");
      $("#import-start-btn").disabled = false;
      return;
    }

    fillEl.style.width = "100%";
    $("#import-progress-wrap").classList.add("hidden");
    $("#import-cancel-btn").classList.add("hidden");
    $("#import-start-btn").disabled = false;

    pendingImport = { toInsert, toUpdate, notFound };
    showImportConfirmation(pendingImport);
  } catch (err) {
    statusEl.textContent = "Fehler: " + err.message;
    $("#import-cancel-btn").classList.add("hidden");
    $("#import-start-btn").disabled = false;
  }
}

function showImportConfirmation({ toInsert, toUpdate }) {
  $("#confirm-new-count").textContent = toInsert.length;
  $("#confirm-update-count").textContent = toUpdate.length;
  const totalDelta = toUpdate.reduce((sum, u) => sum + u.qtyAdd, 0);
  $("#confirm-delta-count").textContent = "+" + totalDelta;

  const listEl = $("#confirm-update-list");
  listEl.innerHTML = "";
  const previewLimit = 100;
  toUpdate.slice(0, previewLimit).forEach((u) => {
    const row = document.createElement("div");
    row.className = "import-confirm-row";
    row.innerHTML = `
      <span class="name">${u.name}</span>
      <span class="delta">${u.qtyBefore} → ${u.qtyAfter} (+${u.qtyAdd})</span>
    `;
    listEl.appendChild(row);
  });
  if (toUpdate.length > previewLimit) {
    const more = document.createElement("div");
    more.className = "import-confirm-more";
    more.textContent = `… und ${toUpdate.length - previewLimit} weitere`;
    listEl.appendChild(more);
  }
  if (toUpdate.length === 0) {
    listEl.innerHTML = `<div class="import-confirm-more">Keine bereits vorhandenen Karten betroffen.</div>`;
  }

  $("#import-confirm").classList.remove("hidden");
}

$("#import-confirm-cancel-btn").addEventListener("click", () => {
  pendingImport = null;
  $("#import-confirm").classList.add("hidden");
  $("#import-status").textContent = "Import abgebrochen.";
});

$("#import-confirm-btn").addEventListener("click", async () => {
  if (!pendingImport) return;
  await executeImport(pendingImport);
  pendingImport = null;
});

async function executeImport({ toInsert, toUpdate, notFound }) {
  $("#import-confirm").classList.add("hidden");
  $("#import-progress-wrap").classList.remove("hidden");
  const statusEl = $("#import-status");
  const fillEl = $("#import-progress-fill");
  fillEl.style.width = "0%";

  try {
    // Neue Karten in Batches speichern
    statusEl.textContent = `Speichere ${toInsert.length} neue Karten …`;
    const batchSize = 200;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      if (batch.length === 0) continue;
      const { error } = await supabaseClient.from("cards").insert(batch);
      if (error) throw new Error("Fehler beim Speichern: " + error.message);
      const pct = Math.round(((i + batch.length) / Math.max(toInsert.length, 1)) * 50);
      fillEl.style.width = pct + "%";
      statusEl.textContent = `Speichere … (${Math.min(i + batch.length, toInsert.length)}/${toInsert.length})`;
    }

    // Bereits vorhandene Karten aktualisieren (Anzahl + fehlende Infos)
    if (toUpdate.length > 0) {
      statusEl.textContent = `Aktualisiere ${toUpdate.length} bereits vorhandene Karten …`;
      for (let i = 0; i < toUpdate.length; i++) {
        const u = toUpdate[i];
        await supabaseClient
          .from("cards")
          .update({
            quantity: u.qtyAfter,
            name_de: u.name_de,
            name_en: u.name_en,
            effect_text_de: u.effect_text_de,
            effect_text_en: u.effect_text_en,
            archetype: u.archetype,
            scale: u.scale,
            image_url: u.image_url,
            ygo_id: u.ygo_id,
          })
          .eq("id", u.id);
        if (i % 50 === 0) {
          const pct = 50 + Math.round((i / toUpdate.length) * 50);
          fillEl.style.width = pct + "%";
        }
      }
    }

    fillEl.style.width = "100%";
    statusEl.textContent = "Import abgeschlossen!";
    showResults(toInsert.length, toUpdate.length, notFound);
    const totalDelta = toUpdate.reduce((sum, u) => sum + u.qtyAdd, 0);
    logHistory(
      "import",
      `CSV-Import: ${toInsert.length} neu, ${toUpdate.length} aktualisiert (+${totalDelta} Exemplare)`,
      {}
    );
    await refreshMyCardIndex();
    renderMineList();
    renderAllList();
  } catch (err) {
    statusEl.textContent = "Fehler: " + err.message;
  }
}

function parseIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = v.toString().trim();
  if (s === "" || s === "-" || s === "?") return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function showResults(insertedCount, updatedCount, notFound) {
  const el = $("#import-results");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="import-results-grid">
      <div class="import-stat"><div class="num">${insertedCount}</div><div class="label">neu importiert</div></div>
      <div class="import-stat"><div class="num">${updatedCount}</div><div class="label">Anzahl aktualisiert</div></div>
      <div class="import-stat"><div class="num">${notFound.length}</div><div class="label">nicht in DB gefunden</div></div>
    </div>
    ${
      notFound.length > 0
        ? `<p style="font-size:0.82rem;color:var(--text-muted);margin-bottom:0.5rem;">
             Diese Karten wurden trotzdem mit deinen Excel-Werten importiert, aber ohne Bild/offizielle ID
             (evtl. abweichende Schreibweise, Alternativ-Art oder sehr neue Karte):
           </p>
           <div class="import-notfound-list">${notFound.map((n) => n).join("<br>")}</div>`
        : ""
    }
  `;
  showToast(`Import fertig: ${insertedCount} neu, ${updatedCount} aktualisiert`);
}

// ============================================================
// REPARATUR: fehlende Übersetzungen ergänzen
// ============================================================
// Behebt nachträglich Karten, die durch den früheren Such-Bug nur mit einer
// Sprache gespeichert wurden. Läuft komplett additiv (füllt nur leere Felder),
// nutzt Batch-Upserts statt einzelner Updates pro Zeile, damit auch mehrere
// tausend Karten in angemessener Zeit durchlaufen.
$("#repair-start-btn").addEventListener("click", runRepair);

async function runRepair() {
  if (!supabaseClient || !currentSession) return;
  const btn = $("#repair-start-btn");
  btn.disabled = true;
  $("#repair-progress-wrap").classList.remove("hidden");
  $("#repair-results").classList.add("hidden");
  const statusEl = $("#repair-status");
  const fillEl = $("#repair-progress-fill");
  fillEl.style.width = "5%";

  try {
    statusEl.textContent = "Lade deine Sammlung …";
    const { data: myCards } = await fetchAllRows(() =>
      supabaseClient
        .from("cards")
        .select("id, ygo_id, name_de, name_en, effect_text_de, effect_text_en, archetype, scale, image_url")
        .eq("owner_id", currentSession.user.id)
        .not("ygo_id", "is", null)
        .order("id", { ascending: true })
    );

    const candidates = (myCards || []).filter(
      (c) => !c.name_de || !c.name_en || !c.effect_text_de || !c.effect_text_en || !c.image_url
    );

    if (candidates.length === 0) {
      fillEl.style.width = "100%";
      statusEl.textContent = "Fertig - nichts zu reparieren gefunden.";
      showRepairResults(0, 0);
      btn.disabled = false;
      return;
    }

    fillEl.style.width = "15%";
    statusEl.textContent = `${candidates.length} lückenhafte Karten gefunden - lade aktuelle Daten …`;

    // Fehlende Karten-Details in Batches per ID nachladen (DE + EN getrennt)
    const ids = [...new Set(candidates.map((c) => c.ygo_id))];
    const chunkSize = 40;
    const enById = new Map();
    const deById = new Map();
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const [enData, deData] = await Promise.all([fetchByIds(chunk, "en"), fetchByIds(chunk, "de")]);
      enData.forEach((c) => enById.set(c.id, c));
      deData.forEach((c) => deById.set(c.id, c));
      const pct = 15 + Math.round(((i + chunk.length) / ids.length) * 45);
      fillEl.style.width = pct + "%";
    }

    fillEl.style.width = "60%";
    statusEl.textContent = "Ergänze fehlende Felder …";

    // Nur die Zeilen sammeln, bei denen sich tatsächlich etwas ändert
    const updates = [];
    let fieldCount = 0;
    candidates.forEach((c) => {
      const en = enById.get(c.ygo_id);
      const de = deById.get(c.ygo_id);
      // owner_id + name_en immer mitschicken: beides NOT-NULL-Felder ohne
      // Standardwert - der Upsert-Mechanismus baut intern eine vollständige
      // Zeile auf, auch wenn am Ende nur ein UPDATE der bestehenden Zeile passiert.
      const patch = {
        id: c.id,
        owner_id: currentSession.user.id,
        name_en: c.name_en || (en ? en.name : c.name_de),
      };
      let changed = false;

      if (!c.name_de && de) { patch.name_de = de.name; changed = true; fieldCount++; }
      if (!c.name_en && en) { patch.name_en = en.name; changed = true; fieldCount++; }
      if (!c.effect_text_de && de) { patch.effect_text_de = de.desc; changed = true; fieldCount++; }
      if (!c.effect_text_en && en) { patch.effect_text_en = en.desc; changed = true; fieldCount++; }
      if (!c.archetype && en && en.archetype) { patch.archetype = en.archetype; changed = true; fieldCount++; }
      if (!c.scale && en && en.scale != null) { patch.scale = en.scale; changed = true; fieldCount++; }
      if (!c.image_url && (en || de)) {
        const src = en || de;
        const img = src.card_images && src.card_images[0] ? src.card_images[0].image_url : null;
        if (img) { patch.image_url = img; changed = true; fieldCount++; }
      }

      if (changed) updates.push(patch);
    });

    // In Batches per Upsert speichern (deutlich schneller als einzelne Updates)
    const batchSize = 200;
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      const { error } = await supabaseClient.from("cards").upsert(batch, { onConflict: "id" });
      if (error) throw new Error("Fehler beim Speichern: " + error.message);
      const pct = 60 + Math.round(((i + batch.length) / Math.max(updates.length, 1)) * 40);
      fillEl.style.width = pct + "%";
      statusEl.textContent = `Speichere … (${Math.min(i + batch.length, updates.length)}/${updates.length})`;
    }

    fillEl.style.width = "100%";
    statusEl.textContent = "Reparatur abgeschlossen!";
    showRepairResults(updates.length, fieldCount);
    logHistory("import", `Reparatur: ${updates.length} Karten ergänzt (${fieldCount} Felder)`, {});
    await refreshMyCardIndex();
    renderMineList();
    renderAllList();
  } catch (err) {
    statusEl.textContent = "Fehler: " + err.message;
  }
  btn.disabled = false;
}

function showRepairResults(repairedCount, fieldCount) {
  const el = $("#repair-results");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="import-results-grid">
      <div class="import-stat"><div class="num">${repairedCount}</div><div class="label">Karten ergänzt</div></div>
      <div class="import-stat"><div class="num">${fieldCount}</div><div class="label">Felder aufgefüllt</div></div>
    </div>
  `;
  showToast(`Reparatur fertig: ${repairedCount} Karten ergänzt`);
}

// ============================================================
// SCANNEN (Kamera + OCR über Tesseract.js)
// ============================================================
let scanStream = null;
let ocrWorker = null;
let scanMode = "single";

$all("#scan-mode-toggle .lang-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.mode === scanMode) return;
    stopScanCamera();
    stopAutoScan();
    resetScan();
    scanMode = btn.dataset.mode;
    $all("#scan-mode-toggle .lang-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $("#scan-intro-single").classList.toggle("hidden", scanMode !== "single");
    $("#scan-intro-auto").classList.toggle("hidden", scanMode !== "auto");
    $("#scan-single-actions").classList.toggle("hidden", scanMode !== "single");
    $("#scan-auto-actions").classList.toggle("hidden", scanMode !== "auto");
  });
});

$("#scan-start-btn").addEventListener("click", startScanCamera);
$("#scan-retry-btn").addEventListener("click", resetScan);
$("#scan-capture-btn").addEventListener("click", captureAndRecognize);
$("#scan-search-btn").addEventListener("click", () => {
  const q = $("#scan-name-input").value.trim();
  if (q.length >= 2) fuzzySearchAndRender(q, "#scan-results", "#scan-search-status");
});
$("#scan-name-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#scan-search-btn").click();
});

async function startScanCamera() {
  $("#scan-status").textContent = "Kamera wird gestartet …";
  ensureCardDbLoaded().catch(() => {}); // Kartendatenbank parallel vorladen
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        // Ohne Auflösungswunsch liefern viele Handys nur 640x480 - zu wenig
        // für den Kartennamen und erst recht für den Passcode. In einer
        // Scan-Halterung füllt die Karte nur einen Teil des Bildes.
        width: { ideal: 2560 },
        height: { ideal: 1440 },
      },
      audio: false,
    });
  } catch (err) {
    $("#scan-status").textContent =
      "Kamera-Zugriff nicht möglich (" + err.message + "). Bitte Kamera-Berechtigung im Browser erlauben.";
    return null;
  }

  // Dauer-Autofokus, wo das Gerät es unterstützt (sonst einfach ignorieren)
  try {
    const track = scanStream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes("continuous")) {
      await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] });
    }
  } catch (err) {
    // Fokus-Steuerung nicht verfügbar - Kamera läuft trotzdem
  }
  setupScanZoom(scanStream.getVideoTracks()[0]);

  const video = $("#scan-video");
  // Vorschau im Seitenverhältnis des Videos zeigen, damit nichts abgeschnitten
  // wird - man sieht genau das, was die Kamera aufnimmt (Handy-Video ist
  // meist 9:16, also schmaler als der 3:4-Platzhalter). Höhe auf ~70 % des
  // Bildschirms begrenzen.
  video.onloadedmetadata = () => {
    const wrap = $("#scan-camera-wrap");
    wrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    wrap.style.maxWidth = `calc(70vh * ${video.videoWidth} / ${video.videoHeight})`;
    wrap.style.marginInline = "auto";
  };
  video.srcObject = scanStream;
  video.classList.remove("hidden");
  $("#scan-placeholder").classList.add("hidden");
  $("#scan-card-guide").classList.remove("hidden");
  $("#scan-start-btn").classList.add("hidden");
  $("#scan-capture-btn").classList.remove("hidden");
  $("#scan-capture-btn").disabled = false;
  $("#scan-status").textContent = "Karte ins Bild legen oder halten (Name gut lesbar), dann Foto aufnehmen.";
  return scanStream;
}

// Zoom-Regler, falls die Kamera Zoom unterstützt (Chrome/Android). In einer
// Scan-Halterung macht etwas Zoom die Karte größer und damit Name und
// Passcode besser lesbar. Die Einstellung wird pro Gerät gemerkt.
const SCAN_ZOOM_KEY = "kartenarchiv-scan-zoom";

function setupScanZoom(track) {
  const wrap = $("#scan-zoom-wrap");
  const input = $("#scan-zoom");
  wrap.classList.add("hidden");
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  if (!caps.zoom || caps.zoom.max <= caps.zoom.min) return;

  input.min = caps.zoom.min;
  input.max = Math.min(caps.zoom.max, 4);
  input.step = caps.zoom.step || 0.1;
  let saved = NaN;
  try {
    saved = parseFloat(localStorage.getItem(SCAN_ZOOM_KEY));
  } catch (err) {
    // kein Speicher verfügbar - Standardzoom
  }
  input.value = Number.isFinite(saved) ? saved : caps.zoom.min;

  const apply = () => {
    const value = parseFloat(input.value);
    $("#scan-zoom-val").textContent = value.toFixed(1) + "×";
    track.applyConstraints({ advanced: [{ zoom: value }] }).catch(() => {});
    try {
      localStorage.setItem(SCAN_ZOOM_KEY, String(value));
    } catch (err) {
      // ignorieren
    }
  };
  input.oninput = apply;
  apply();
  wrap.classList.remove("hidden");
}

function stopScanCamera() {
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
}

// ============================================================
// BILDAUSSCHNITT DER KARTE
// ============================================================
// Die Karte wird über den gestrichelten Ausrichtrahmen gefunden: alles
// innerhalb des Rahmens gilt als Karte. Aus diesem Kartenbild werden dann
// Name, Set-Code und Passcode an ihren festen Positionen ausgeschnitten.

// Rechnet die Position des sichtbaren Ausrichtrahmens (CSS-Pixel) auf die
// tatsächlichen Quellpixel des Kamera-Streams um - notwendig, weil das
// <video>-Element per object-fit:cover skaliert/beschnitten dargestellt wird.
function getCoverSourceRect(video, displayRect, videoRect) {
  const leftFrac = (displayRect.left - videoRect.left) / videoRect.width;
  const topFrac = (displayRect.top - videoRect.top) / videoRect.height;
  const widthFrac = displayRect.width / videoRect.width;
  const heightFrac = displayRect.height / videoRect.height;

  const videoAspect = video.videoWidth / video.videoHeight;
  const boxAspect = videoRect.width / videoRect.height;
  let visW, visH, cropX, cropY;
  if (videoAspect > boxAspect) {
    visH = video.videoHeight;
    visW = boxAspect * visH;
    cropX = (video.videoWidth - visW) / 2;
    cropY = 0;
  } else {
    visW = video.videoWidth;
    visH = visW / boxAspect;
    cropX = 0;
    cropY = (video.videoHeight - visH) / 2;
  }

  return {
    sx: cropX + leftFrac * visW,
    sy: cropY + topFrac * visH,
    sw: widthFrac * visW,
    sh: heightFrac * visH,
  };
}

// Ausrichtrahmen als Anteile (0..1) des Kamerabilds - damit lässt er sich
// auch auf ein Foto mit höherer Auflösung übertragen.
function getGuideFractions(video) {
  const { sx, sy, sw, sh } = getCoverSourceRect(
    video,
    $("#scan-card-guide").getBoundingClientRect(),
    video.getBoundingClientRect()
  );
  return { fx: sx / video.videoWidth, fy: sy / video.videoHeight, fw: sw / video.videoWidth, fh: sh / video.videoHeight };
}

const MAX_CARD_HEIGHT = 1800; // größere Fotos werden verkleinert (Speicher/Tempo)

function cropToCanvas(source, srcW, srcH, f) {
  const sx = f.fx * srcW;
  const sy = f.fy * srcH;
  const sw = f.fw * srcW;
  const sh = f.fh * srcH;
  const scale = Math.min(1, MAX_CARD_HEIGHT / sh);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Sucht die Karte selbstständig im Bild (source = Video, Foto oder Canvas),
// damit sie nicht exakt im Rahmen liegen muss - z.B. in einer Scan-Halterung,
// wo die Karte immer an derselben Stelle, aber nicht mittig liegt.
// Liefert { x, y, w, h } als Anteile oder null.
function detectCardBox(source, srcW = source.width, srcH = source.height) {
  const w = 240;
  const h = Math.max(1, Math.round((w * srcH) / srcW));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, w, h);
  return ScanEngine.locateCard(ctx.getImageData(0, 0, w, h).data, w, h);
}

// Karte aus einem Bild ausschneiden: automatisch gefunden, sonst der
// Ausrichtrahmen (fallbackFractions) - oder null, wenn beides fehlt.
function cropCard(source, srcW, srcH, fallbackFractions) {
  const box = detectCardBox(source, srcW, srcH);
  const f = box ? { fx: box.x, fy: box.y, fw: box.w, fh: box.h } : fallbackFractions;
  return f ? cropToCanvas(source, srcW, srcH, f) : null;
}

// Standbild aus dem laufenden Video (schnell, für Auto-Scan und als Fallback)
function captureCardCanvas() {
  const video = $("#scan-video");
  return cropCard(video, video.videoWidth, video.videoHeight, getGuideFractions(video));
}

// Einzelbild: wenn möglich ein echtes Foto in voller Sensorauflösung
// (Chrome/Android: ImageCapture.takePhoto). Die Karte wird darin selbst
// gesucht; den Ausrichtrahmen als Ersatz nur, wenn das Foto dasselbe
// Seitenverhältnis wie das Video hat. Liefert null, wenn kein besseres Foto möglich ist.
async function takeHiResCardPhoto(fractions) {
  const video = $("#scan-video");
  const track = scanStream && scanStream.getVideoTracks()[0];
  if (!track || typeof ImageCapture === "undefined") return null;
  try {
    const blob = await Promise.race([
      new ImageCapture(track).takePhoto(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000)),
    ]);
    const bitmap = await createImageBitmap(blob);
    const videoAspect = video.videoWidth / video.videoHeight;
    const photoAspect = bitmap.width / bitmap.height;
    const sameView = Math.abs(photoAspect - videoAspect) / videoAspect < 0.03;
    const canvas =
      bitmap.width > video.videoWidth ? cropCard(bitmap, bitmap.width, bitmap.height, sameView ? fractions : null) : null;
    bitmap.close();
    return canvas;
  } catch (err) {
    return null;
  }
}

// ============================================================
// TEXTERKENNUNG (Tesseract) AN FESTEN KARTENPOSITIONEN
// ============================================================
// Positionen als Anteile der Karte [x0, x1, y0, y1]. Der Namensbereich endet
// VOR dem Attribut-Symbol (dort steht z.B. "FINSTERNIS", das sonst im Namen
// landet). "auto" = per locateNameRect gefundene Namenszeile.
// mode: "raw" (unverändert, Tesseract binarisiert selbst) / "gray" / "adaptive",
// psm: Tesseract-Seitenmodus (13 = eine Rohzeile, 7 = eine Zeile, 6 = Block).
// Reihenfolge und Varianten per Vergleichstest gewählt (test-scans/_referenz):
// automatisch gefundene Zeile ~88 % richtig, feste Ausschnitte nur 40-60 %,
// weil schon 2-3 % Versatz der Karte den Namen abschneiden.
const NAME_FALLBACK_RECT = [0.05, 0.83, 0.03, 0.12];
const NAME_STEPS = [
  { rect: "auto", mode: "raw", psm: "13", label: "Name" },
  { rect: "auto", mode: "gray", psm: "13", label: "Name (Kontrast)" },
  { rect: [0.04, 0.85, 0.0, 0.16], mode: "raw", psm: "6", label: "Name (großzügig)" },
  { rect: [0.04, 0.85, 0.06, 0.135], mode: "raw", psm: "7", label: "Name (tiefer)" },
  { rect: [0.05, 0.83, 0.02, 0.105], mode: "gray", psm: "13", label: "Name (höher)" },
];
// Der 8-stellige Passcode unten links (= Karten-ID) hilft vor allem, wenn der
// Name fehlt oder nicht in der Datenbank steht (manche deutsche Namen fehlen
// bei YGOPRODeck). Die Zeile wird im unteren Kartenbereich gesucht und so
// skaliert, dass die Schrift ~30 px hoch ist. Den Set-Code (z.B. PHRE-DE049)
// liest Tesseract auf echten Fotos nicht brauchbar (zu klein, kontrastarm) -
// daher kein eigener Schritt, ScanEngine wertet ihn aber aus, falls er in
// einem Text auftaucht. Werte per Fototest gewählt (test-scans/_referenz/codes.js).
const PASSCODE_STEP = { region: [0.0, 0.5, 0.9, 1.0], searchFrom: 0.1, searchTo: 0.9, textFrac: 0.012, textPx: 30 };

// Ausschnitt -> auf Zielhöhe skaliert, vorverarbeitet (siehe
// ScanEngine.preprocessPixels) und mit weißem Rand versehen (Tesseract
// erkennt Text direkt an der Bildkante schlecht).
function prepareOcrCanvas(cardCanvas, [x0, x1, y0, y1], targetHeight, mode) {
  const sx = cardCanvas.width * x0;
  const sy = cardCanvas.height * y0;
  const sw = cardCanvas.width * (x1 - x0);
  const sh = cardCanvas.height * (y1 - y0);
  const w = Math.max(1, Math.round(sw * (targetHeight / sh)));
  const h = targetHeight;

  const work = document.createElement("canvas");
  work.width = w;
  work.height = h;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  if (mode !== "raw") ScanEngine.preprocessPixels(img.data, w, h, mode);
  ctx.putImageData(img, 0, 0);

  const pad = Math.round(h * 0.15);
  const out = document.createElement("canvas");
  out.width = w + 2 * pad;
  out.height = h + 2 * pad;
  const octx = out.getContext("2d");
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(work, pad, pad);
  return out;
}

// Sucht die Namenszeile im oberen Kartenbereich, damit der Ausschnitt auch
// bei ungenau ausgerichteter Karte auf dem Namen sitzt. Gesucht wird nur in
// der linken Hälfte (Namen stehen links, Level-Sterne/Attribut rechts).
// Liefert [x0, x1, y0, y1] wie NAME_STEPS oder null.
const NAME_SEARCH_REGION = [0.06, 0.6, 0.0, 0.2];

// Sucht in einem Bereich der Karte ([x0, x1, y0, y1]) die stärkste
// Textzeile; from/to begrenzen die Suche innerhalb des Bereichs.
// Liefert die Zeile als [top, bottom] in Kartenanteilen oder null.
function locateTextRow(cardCanvas, [x0, x1, y0, y1], from, to) {
  const sw = cardCanvas.width * (x1 - x0);
  const sh = cardCanvas.height * (y1 - y0);
  const w = 300;
  const h = Math.max(20, Math.round((w * sh) / sw));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cardCanvas, cardCanvas.width * x0, cardCanvas.height * y0, sw, sh, 0, 0, w, h);
  const band = ScanEngine.locateTextBand(ctx.getImageData(0, 0, w, h).data, w, h, from, to);
  if (!band) return null;
  return [y0 + band[0] * (y1 - y0), y0 + band[1] * (y1 - y0)];
}

function locateNameRect(cardCanvas) {
  // Suchbereich: Kartenhöhe ~2-12 % (Name), darunter folgen die Level-Sterne
  const row = locateTextRow(cardCanvas, NAME_SEARCH_REGION, 0.1, 0.6);
  if (!row) return null;
  return [0.04, 0.84, Math.max(0, row[0] - 0.012), Math.min(0.25, row[1] + 0.012)];
}

// Passcode-Zeile ausschneiden und auf lesbare Schriftgröße bringen
function preparePasscodeCanvas(cardCanvas) {
  const s = PASSCODE_STEP;
  const row = locateTextRow(cardCanvas, s.region, s.searchFrom, s.searchTo);
  let rect = s.region;
  if (row) {
    const pad = (row[1] - row[0]) * 0.35;
    rect = [s.region[0], s.region[1], Math.max(0, row[0] - pad), Math.min(1, row[1] + pad)];
  }
  const target = Math.round(((rect[3] - rect[2]) / s.textFrac) * s.textPx);
  return prepareOcrCanvas(cardCanvas, rect, Math.min(400, target), "gray");
}

async function getOcrWorker() {
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker("eng+deu");
  return ocrWorker;
}

async function ocrText(canvas, { psm, whitelist = "" }) {
  const worker = await getOcrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist });
  const { data } = await worker.recognize(canvas);
  return data.text || "";
}

// Erkennt eine Karte aus dem Kartenbild. Reihenfolge: Name, Passcode, dann
// weitere Namensvarianten - bricht ab, sobald das Ergebnis sicher ist. Jeder
// Schritt wird gegen die Kartendatenbank geprüft (ScanEngine.rankCandidates),
// nicht gegen Tesseracts eigene Sicherheit.
async function recognizeCard(cardCanvas, onProgress) {
  const steps = [
    { kind: "name", ...NAME_STEPS[0] },
    { kind: "code", label: "Passcode" },
    ...NAME_STEPS.slice(1).map((s) => ({ kind: "name", ...s })),
  ];
  const autoRect = locateNameRect(cardCanvas) || NAME_FALLBACK_RECT;
  const nameTexts = [];
  const nameCanvases = [];
  const codeTexts = [];
  let ranking = { candidates: [], confidence: "none" };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (onProgress) onProgress(s.label);
    try {
      if (s.kind === "name") {
        const rect = s.rect === "auto" ? autoRect : s.rect;
        const canvas = prepareOcrCanvas(cardCanvas, rect, s.psm === "6" ? 200 : 96, s.mode);
        nameTexts.push(await ocrText(canvas, { psm: s.psm }));
        nameCanvases.push(canvas);
      } else {
        codeTexts.push(await ocrText(preparePasscodeCanvas(cardCanvas), { psm: "6" }));
      }
    } catch (err) {
      continue; // einzelner Schritt fehlgeschlagen - mit dem nächsten weitermachen
    }
    await ensureCardDbLoaded();
    ranking = ScanEngine.rankCandidates(cardIndex, { nameTexts, codeTexts });
    const top = ranking.candidates[0];
    // Früh aufhören, sobald das Ergebnis eindeutig ist (spart beim Auto-Scan viel
    // Zeit); bei nur knapp sicherem Namen erst noch den Passcode gegenprüfen.
    if (ranking.confidence === "sure" && (i >= 1 || top.score >= 0.95)) break;
  }

  // Für Anzeige/Diagnose: der Namensausschnitt, der am besten zur Top-Karte passt
  const top = ranking.candidates[0] || null;
  let bestIdx = 0;
  let bestScore = -1;
  nameTexts.forEach((t, k) => {
    const score = top ? ScanEngine.nameScoreFor(cardIndex, top.id, t) : t.trim().length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = k;
    }
  });

  return {
    cards: ranking.candidates.slice(0, 6).map((c) => buildMergedCardById(c.id)).filter(Boolean),
    top,
    confidence: ranking.confidence,
    rawName: (nameTexts[bestIdx] || "").replace(/\s+/g, " ").trim(),
    debugCanvas: nameCanvases[bestIdx] || null,
    ocr: { nameTexts, codeTexts }, // Rohtexte für Diagnose
  };
}

// ============================================================
// EINZELBILD-MODUS
// ============================================================
async function captureAndRecognize() {
  const video = $("#scan-video");
  $("#scan-capture-btn").disabled = true;
  $("#scan-status").textContent = "Foto wird aufgenommen …";

  const fractions = getGuideFractions(video);
  const frameCanvas = cropToCanvas(video, video.videoWidth, video.videoHeight, fractions);
  const photoCanvas = await takeHiResCardPhoto(fractions);
  const cardCanvas = photoCanvas || frameCanvas;

  $("#scan-captured-img").src = cardCanvas.toDataURL("image/jpeg", 0.9);
  $("#scan-captured-img").classList.remove("hidden");
  $("#scan-video").classList.add("hidden");
  $("#scan-card-guide").classList.add("hidden");
  stopScanCamera();

  $("#scan-capture-btn").classList.add("hidden");
  $("#scan-capture-btn").disabled = false;
  $("#scan-retry-btn").classList.remove("hidden");
  $("#scan-status").textContent = "Erkenne Karte … (beim ersten Mal dauert das Laden der Erkennung etwas länger)";

  const progress = (label) => {
    $("#scan-status").textContent = `Erkenne Karte … (${label})`;
  };

  try {
    let result = await recognizeCard(cardCanvas, progress);
    // Falls das hochaufgelöste Foto nicht eindeutig war: Video-Standbild als
    // Gegenprobe (manche Kameras schneiden Foto und Video unterschiedlich zu).
    if (photoCanvas && result.confidence !== "sure") {
      const alt = await recognizeCard(frameCanvas, progress);
      if ((alt.top ? alt.top.score : 0) > (result.top ? result.top.score : 0)) result = alt;
    }

    if (result.debugCanvas) {
      $("#scan-debug-img").src = result.debugCanvas.toDataURL("image/png");
      $("#scan-debug").classList.remove("hidden");
    }

    const best = result.confidence !== "none" ? result.cards[0] : null;
    $("#scan-name-row").classList.remove("hidden");
    $("#scan-name-input").value = best ? best.name_de || best.name_en : result.rawName;

    if (result.confidence === "sure") {
      $("#scan-status").textContent = `Erkannt: ${best.name_de || best.name_en}`;
      $("#scan-search-status").textContent = "Sicher erkannt – falls doch falsch, unten die richtige Karte wählen:";
    } else if (result.confidence === "unsure") {
      $("#scan-status").textContent = "Nicht ganz sicher – bitte die richtige Karte auswählen.";
      $("#scan-search-status").textContent = `${result.cards.length} mögliche Treffer (wahrscheinlichster zuerst):`;
    } else {
      $("#scan-status").textContent = "Keine passende Karte gefunden. Namen korrigieren und „Suchen“ drücken.";
      $("#scan-search-status").textContent = result.cards.length ? "Vielleicht eine davon?" : "";
    }
    renderSearchResults(result.cards, "#scan-results");
    if (best) $("#scan-results").firstElementChild.classList.add("result-card-best");
    if (result.confidence === "sure") openAddModal(best);
  } catch (err) {
    $("#scan-status").textContent = "Fehler bei der Erkennung: " + err.message;
    $("#scan-name-row").classList.remove("hidden");
  }
}

function resetScan() {
  stopScanCamera();
  $("#scan-video").classList.add("hidden");
  $("#scan-captured-img").classList.add("hidden");
  $("#scan-card-guide").classList.add("hidden");
  $("#scan-placeholder").classList.remove("hidden");
  $("#scan-start-btn").classList.remove("hidden");
  $("#scan-capture-btn").classList.add("hidden");
  $("#scan-capture-btn").disabled = false;
  $("#scan-retry-btn").classList.add("hidden");
  $("#scan-name-row").classList.add("hidden");
  $("#scan-debug").classList.add("hidden");
  $("#scan-name-input").value = "";
  $("#scan-status").textContent = "";
  $("#scan-search-status").textContent = "";
  $("#scan-results").innerHTML = "";
  $("#scan-queue").classList.add("hidden");
  $("#scan-queue").innerHTML = "";
  $("#scan-review").classList.add("hidden");
  $("#scan-detect-box").classList.add("hidden");
  $("#scan-camera-wrap").removeAttribute("style");
  $("#auto-scan-start-btn").classList.remove("hidden");
  $("#auto-scan-stop-btn").classList.add("hidden");
  $("#auto-scan-plus-btn").classList.add("hidden");
}

// ============================================================
// AUTO-SCAN (Serienerfassung: "neue Karte liegt ruhig im Bild")
// ============================================================
// Statt auf Bewegung zu warten (ein schnell eingeworfener Kartenwechsel
// fällt oft zwischen zwei Messungen), vergleicht der Auto-Scan das ruhige
// Bild mit dem Bild der zuletzt erfassten Karte: Hat sich im Kartenbereich
// genug verändert, ist es eine neue Karte. Eine Hand, die kurz ins Bild
// greift, ohne die Karte zu wechseln, löst dadurch keine zweite Erfassung aus.
let autoScanQueue = []; // {id, thumb, guess, matched, alternatives, confidence, quantity, status}
let motionInterval = null;
const motionCanvas = document.createElement("canvas");
let lastGray = null; // Graubild der letzten Messung
let lastCapturedGray = null; // Graubild bei der letzten Erfassung
let stillTicks = 0;
let lastScanHint = "";
let lastRecognizedId = null; // zuletzt sicher erkannte Karte (Reihenfolge der Erfassung)
let ocrChain = Promise.resolve(); // serialisiert OCR-Aufrufe (ein Worker kann nur 1 gleichzeitig)

const MOTION_WIDTH = 160; // Breite des Vergleichsbilds in Pixeln
const PIXEL_DIFF = 28; // Grauwertänderung, ab der ein Pixel als "verändert" zählt
const STILL_FRACTION = 0.015; // weniger veränderte Pixel als das = Bild ist ruhig
const NEW_CARD_FRACTION = 0.04; // mehr veränderte Kartenpixel als bei der letzten Erfassung = neue Karte
const REQUIRED_STILL_TICKS = 4; // ~4 x 300 ms Ruhe nötig vor dem Auslösen
const MOTION_TICK_MS = 300;

$("#auto-scan-start-btn").addEventListener("click", startAutoScan);
$("#auto-scan-stop-btn").addEventListener("click", stopAutoScanAndReview);
// Zwei gleiche Karten direkt nacheinander sehen für die Kamera identisch aus -
// dafür gibt es "+1": erhöht die Anzahl der zuletzt erfassten Karte.
// (?. : falls ein Browser noch eine ältere index.html ohne den Knopf im Cache
// hat, soll nicht das ganze Skript abbrechen)
$("#auto-scan-plus-btn")?.addEventListener("click", () => {
  const last = autoScanQueue[autoScanQueue.length - 1];
  if (!last) return;
  last.quantity++;
  renderScanQueue();
  showToast(`Anzahl der letzten Karte: ${last.quantity}`);
});
$("#scan-review-save-btn").addEventListener("click", saveAutoScanQueue);
$("#scan-review-discard-btn").addEventListener("click", () => {
  autoScanQueue = [];
  $("#scan-review").classList.add("hidden");
  resetScan();
});

async function startAutoScan() {
  autoScanQueue = [];
  lastGray = null;
  lastCapturedGray = null;
  stillTicks = 0;
  lastScanHint = "";
  lastRecognizedId = null;
  renderScanQueue();

  const stream = await startScanCamera();
  if (!stream) return;

  $("#auto-scan-start-btn").classList.add("hidden");
  $("#auto-scan-stop-btn").classList.remove("hidden");
  $("#auto-scan-plus-btn").classList.remove("hidden");
  $("#scan-capture-btn").classList.add("hidden"); // Auto-Scan löst selbst aus
  $("#scan-card-guide").classList.add("hidden"); // stattdessen grüner Rahmen um die erkannte Karte
  $("#scan-queue").classList.remove("hidden");
  setScanHint("Auto-Scan läuft – Karten nacheinander einlegen.");

  await getOcrWorker(); // Erkennung im Hintergrund vorladen

  motionInterval = setInterval(checkMotionTick, MOTION_TICK_MS);
}

function stopAutoScan() {
  if (motionInterval) {
    clearInterval(motionInterval);
    motionInterval = null;
  }
  stopScanCamera();
  $("#scan-motion-badge").classList.add("hidden");
  $("#scan-detect-box").classList.add("hidden");
  $("#auto-scan-plus-btn").classList.add("hidden");
}

function stopAutoScanAndReview() {
  stopAutoScan();
  $("#scan-video").classList.add("hidden");
  $("#scan-card-guide").classList.add("hidden");
  $("#scan-placeholder").classList.remove("hidden");
  $("#scan-camera-wrap").removeAttribute("style");
  $("#auto-scan-start-btn").classList.remove("hidden");
  $("#auto-scan-stop-btn").classList.add("hidden");
  showScanReview();
}

// Anteil der Pixel, die sich zwischen zwei Graubildern deutlich unterscheiden
// - optional nur innerhalb eines Bereichs (box in Anteilen).
function changedFraction(a, b, w, h, box) {
  const x0 = box ? Math.floor(box.x * w) : 0;
  const x1 = box ? Math.min(w, Math.ceil((box.x + box.w) * w)) : w;
  const y0 = box ? Math.floor(box.y * h) : 0;
  const y1 = box ? Math.min(h, Math.ceil((box.y + box.h) * h)) : h;
  let changed = 0;
  let total = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0, p = y * w + x0; x < x1; x++, p++) {
      if (Math.abs(a[p] - b[p]) > PIXEL_DIFF) changed++;
      total++;
    }
  }
  return total ? changed / total : 0;
}

function setScanHint(text) {
  if (text === lastScanHint) return;
  lastScanHint = text;
  $("#scan-status").textContent = text;
}

function checkMotionTick() {
  const video = $("#scan-video");
  if (!video.videoWidth) return;

  // Ganzes Kamerabild beobachten: die Karte muss nicht im Rahmen liegen
  // (Scan-Halterung), sie wird automatisch gefunden.
  const w = MOTION_WIDTH;
  const h = Math.round((w * video.videoHeight) / video.videoWidth);
  motionCanvas.width = w;
  motionCanvas.height = h;
  const ctx = motionCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) gray[p] = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) | 0;

  const box = ScanEngine.locateCard(rgba, w, h);
  showDetectedCard(video, box);

  const moved = lastGray && lastGray.length === gray.length ? changedFraction(gray, lastGray, w, h) : 1;
  stillTicks = moved < STILL_FRACTION ? stillTicks + 1 : 0;
  lastGray = gray;

  if (!box) {
    $("#scan-motion-badge").classList.add("hidden");
    setScanHint("Keine vollständige Karte im Bild – Karte einlegen, ggf. Zoom verringern.");
    return;
  }
  const touchesEdge = box.y < 0.005 || box.y + box.h > 0.995 || box.x < 0.005 || box.x + box.w > 0.995;
  setScanHint(
    touchesEdge
      ? "⚠ Karte stößt an den Bildrand – Zoom etwas verringern."
      : "Auto-Scan läuft – Karten nacheinander einlegen."
  );

  const isNew =
    !lastCapturedGray || lastCapturedGray.length !== gray.length || changedFraction(gray, lastCapturedGray, w, h, box) > NEW_CARD_FRACTION;
  if (!isNew) {
    $("#scan-motion-badge").classList.add("hidden");
    return;
  }
  if (stillTicks >= REQUIRED_STILL_TICKS) {
    const previousGray = lastCapturedGray;
    lastCapturedGray = gray;
    $("#scan-motion-badge").classList.add("hidden");
    captureForAutoScan(gray, previousGray);
  } else {
    $("#scan-motion-badge").classList.remove("hidden"); // neue Karte erkannt, wartet auf Ruhe
  }
}

// Grüner Rahmen um die erkannte Karte in der Vorschau
function showDetectedCard(video, box) {
  const el = $("#scan-detect-box");
  if (!box) {
    el.classList.add("hidden");
    return;
  }
  const videoRect = video.getBoundingClientRect();
  const wrapRect = $("#scan-camera-wrap").getBoundingClientRect();
  // Umkehrung von getCoverSourceRect: Videoanteile -> Bildschirmposition
  const videoAspect = video.videoWidth / video.videoHeight;
  const boxAspect = videoRect.width / videoRect.height;
  let scale, offX, offY;
  if (videoAspect > boxAspect) {
    scale = videoRect.height / video.videoHeight;
    offX = (videoRect.width - video.videoWidth * scale) / 2;
    offY = 0;
  } else {
    scale = videoRect.width / video.videoWidth;
    offX = 0;
    offY = (videoRect.height - video.videoHeight * scale) / 2;
  }
  el.style.left = videoRect.left - wrapRect.left + offX + box.x * video.videoWidth * scale + "px";
  el.style.top = videoRect.top - wrapRect.top + offY + box.y * video.videoHeight * scale + "px";
  el.style.width = box.w * video.videoWidth * scale + "px";
  el.style.height = box.h * video.videoHeight * scale + "px";
  el.classList.remove("hidden");
}

// gray / previousGray: Vergleichsbild dieser Erfassung und der davor - wird
// gebraucht, falls sich die Erfassung als "keine Karte" herausstellt (z.B.
// eine Hand lag still im Bild), um wieder mit der vorherigen Karte zu vergleichen.
function captureForAutoScan(gray = null, previousGray = null) {
  const cardCanvas = captureCardCanvas();
  const thumb = cardCanvas.toDataURL("image/jpeg", 0.75);

  const item = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 7),
    thumb,
    guess: "",
    matched: null,
    alternatives: [],
    confidence: "none",
    quantity: 1,
    status: "ocr",
    gray,
    previousGray,
  };
  autoScanQueue.push(item);
  renderScanQueue();

  ocrChain = ocrChain.then(() => processAutoScanItem(item, cardCanvas)).catch(() => {});
}

async function processAutoScanItem(item, cardCanvas) {
  try {
    const result = await recognizeCard(cardCanvas);
    item.guess = result.rawName;
    item.alternatives = result.cards;
    item.confidence = result.confidence;
    const match = result.confidence !== "none" ? result.cards[0] : null;

    if (match && result.confidence === "sure" && match.id === lastRecognizedId) {
      // Dieselbe Karte wie bei der Erfassung davor: fast immer dieselbe
      // physische Karte (Hand lag kurz still darauf, Schatten ...). Eine
      // echte zweite Kopie zählt der "+1"-Knopf - zwei gleiche Karten sehen
      // in der Halterung ohnehin identisch aus.
      autoScanQueue = autoScanQueue.filter((q) => q.id !== item.id);
      refreshScanViews();
      return;
    }
    if (match && result.confidence === "sure") {
      lastRecognizedId = match.id;
      // Dieselbe Karte in diesem Lauf schon früher sicher erkannt? Dann nur Anzahl erhöhen.
      const existing = autoScanQueue.find(
        (q) => q.id !== item.id && q.confidence === "sure" && q.matched && q.matched.id === match.id
      );
      if (existing) {
        existing.quantity++;
        autoScanQueue = autoScanQueue.filter((q) => q.id !== item.id);
        refreshScanViews();
        return;
      }
    }
    item.matched = match;
    item.status = !match ? "nomatch" : result.confidence === "sure" ? "matched" : "unsure";
  } catch (err) {
    item.status = "error";
  }
  // Keine Karte erkannt -> war vermutlich keine neue Karte (Hand, Schatten):
  // wieder mit der vorherigen Karte vergleichen, damit sie nicht doppelt zählt
  if (!item.matched && item.gray && lastCapturedGray === item.gray) lastCapturedGray = item.previousGray;
  item.gray = item.previousGray = null;
  refreshScanViews();
}

// Warteschlange und - falls schon geöffnet - die Übersicht aktualisieren
// (Erkennung kann noch laufen, wenn der Scan-Lauf bereits beendet wurde).
function refreshScanViews() {
  renderScanQueue();
  if (!$("#scan-review").classList.contains("hidden")) renderScanReview();
}

// ============================================================
// KARTENDATENBANK FÜR DIE ERKENNUNG
// ============================================================
let cardDbEnById = null;
let cardDbDeById = null;
let cardIndex = null; // ScanEngine-Index (Namen, Set-Codes, Passcodes)
let cardDbLoadPromise = null;

function ensureCardDbLoaded() {
  if (cardIndex) return Promise.resolve();
  if (cardDbLoadPromise) return cardDbLoadPromise;

  cardDbLoadPromise = (async () => {
    const [en, de] = await Promise.all([fetchFullYgoDatabase("en"), fetchFullYgoDatabase("de")]);
    cardDbEnById = new Map(en.map((c) => [c.id, c]));
    cardDbDeById = new Map(de.map((c) => [c.id, c]));
    cardIndex = ScanEngine.buildIndex(en, de);
  })().catch((err) => {
    cardDbLoadPromise = null; // beim nächsten Versuch erneut laden
    throw err;
  });
  return cardDbLoadPromise;
}

function buildMergedCardById(id) {
  const en = cardDbEnById.get(id);
  const de = cardDbDeById.get(id);
  const canonical = en || de;
  if (!canonical) return null;
  return {
    id: canonical.id,
    name_en: en ? en.name : canonical.name,
    name_de: de ? de.name : null,
    type: canonical.type,
    race: canonical.race,
    attribute: canonical.attribute,
    atk: canonical.atk,
    def: canonical.def,
    level: canonical.level ?? canonical.linkval,
    archetype: canonical.archetype || null,
    scale: canonical.scale ?? null,
    desc_de: de ? de.desc : null,
    desc_en: en ? en.desc : canonical.desc,
    image: canonical.card_images && canonical.card_images[0] ? canonical.card_images[0].image_url : "",
  };
}

// Tippfehlertolerante Suche nach Namen (für manuell korrigierten Text).
async function fuzzyCandidates(query, limit = 6) {
  await ensureCardDbLoaded();
  const { candidates, confidence } = ScanEngine.rankCandidates(cardIndex, { nameTexts: [query] });
  return { cards: candidates.slice(0, limit).map((c) => buildMergedCardById(c.id)).filter(Boolean), confidence };
}

async function fuzzySearchAndRender(query, resultsSel, statusSel) {
  $(statusSel).textContent = "Suche ähnliche Karten …";
  $(resultsSel).innerHTML = "";
  const { cards } = await fuzzyCandidates(query, 6);
  if (cards.length === 0) {
    $(statusSel).textContent = "Keine ähnlichen Karten gefunden. Bitte Namen manuell korrigieren.";
    return;
  }
  $(statusSel).textContent = `${cards.length} mögliche Treffer (nach Ähnlichkeit sortiert) - bitte die richtige Karte auswählen:`;
  renderSearchResults(cards, resultsSel);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderScanQueue() {
  $("#auto-scan-count").textContent = autoScanQueue.length;
  const container = $("#scan-queue");
  container.innerHTML = "";
  autoScanQueue.forEach((item) => {
    const el = document.createElement("div");
    el.className = "scan-queue-item";
    const img = item.matched ? item.matched.image : item.thumb;
    let statusHtml = "";
    if (item.status === "ocr") statusHtml = `<div class="status-badge">⏳</div>`;
    else if (item.status === "unsure") statusHtml = `<div class="status-badge status-unsure">?</div>`;
    else if (item.status === "nomatch") statusHtml = `<div class="status-badge">❓</div>`;
    else if (item.status === "error") statusHtml = `<div class="status-badge">⚠️</div>`;
    el.innerHTML = `
      <img src="${img}" alt="" />
      ${item.quantity > 1 ? `<span class="qty-badge">×${item.quantity}</span>` : ""}
      ${statusHtml}
    `;
    container.appendChild(el);
  });
}

// ============================================================
// REVIEW-BILDSCHIRM NACH EINEM AUTO-SCAN-LAUF
// ============================================================
function showScanReview() {
  $("#scan-queue").classList.add("hidden");
  $("#scan-review").classList.remove("hidden");
  renderScanReview();
}

function renderScanReview() {
  $("#scan-review-count").textContent = autoScanQueue.length;
  const list = $("#scan-review-list");
  list.innerHTML = "";

  if (autoScanQueue.length === 0) {
    list.innerHTML = `<div class="empty-state">Keine Karten erfasst.</div>`;
    return;
  }

  autoScanQueue.forEach((item) => {
    const row = document.createElement("div");
    row.className = "scan-review-row" + (item.status === "unsure" || item.status === "nomatch" ? " needs-check" : "");
    const nameVal = item.matched ? item.matched.name_de || item.matched.name_en : item.guess;
    let metaText;
    if (item.status === "ocr") metaText = "Wird erkannt …";
    else if (item.matched) {
      metaText = [item.matched.type, item.matched.attribute].filter(Boolean).join(" · ");
      if (item.status === "unsure") metaText = "⚠ Nicht sicher – bitte prüfen · " + metaText;
    } else metaText = "Keine automatische Zuordnung – Name prüfen und erneut suchen";

    const alts = item.alternatives || [];
    const altSelect =
      alts.length > 1
        ? `<select class="review-alt" title="Andere Treffer">
            ${alts
              .map(
                (c) =>
                  `<option value="${c.id}" ${item.matched && item.matched.id === c.id ? "selected" : ""}>${escapeHtml(c.name_de || c.name_en)}</option>`
              )
              .join("")}
            ${item.matched ? "" : `<option value="" selected>– andere Treffer –</option>`}
          </select>`
        : "";

    row.innerHTML = `
      <img src="${item.matched ? item.matched.image : item.thumb}" alt="" />
      ${item.matched ? `<img class="review-photo" src="${item.thumb}" alt="Foto" title="Dein Foto" />` : ""}
      <div class="review-main">
        <input type="text" class="review-name-input" value="${escapeHtml(nameVal)}" placeholder="Kartenname …" />
        ${altSelect}
        <span class="review-meta">${escapeHtml(metaText)}</span>
      </div>
      <input type="number" class="review-qty" min="1" max="99" value="${item.quantity}" />
      <button class="icon-btn" data-action="research" title="Erneut suchen">🔍</button>
      <button class="icon-btn danger" data-action="remove" title="Entfernen">🗑</button>
    `;

    row.querySelector(".review-qty").addEventListener("change", (e) => {
      item.quantity = parseInt(e.target.value, 10) || 1;
    });
    const select = row.querySelector(".review-alt");
    if (select) {
      select.addEventListener("change", () => {
        const chosen = alts.find((c) => String(c.id) === select.value);
        if (!chosen) return;
        item.matched = chosen;
        item.status = "matched"; // vom Nutzer bestätigt
        renderScanReview();
      });
    }
    row.querySelector('[data-action="remove"]').addEventListener("click", () => {
      autoScanQueue = autoScanQueue.filter((q) => q.id !== item.id);
      renderScanReview();
    });
    row.querySelector('[data-action="research"]').addEventListener("click", async () => {
      const newName = row.querySelector(".review-name-input").value.trim();
      if (!newName) return;
      row.querySelector(".review-meta").textContent = "Suche …";
      const { cards, confidence } = await fuzzyCandidates(newName, 6);
      item.alternatives = cards;
      item.matched = cards[0] || null;
      item.status = !item.matched ? "nomatch" : confidence === "sure" ? "matched" : "unsure";
      renderScanReview();
    });

    list.appendChild(row);
  });
}

async function saveAutoScanQueue() {
  if (!currentSession) return;
  const validItems = autoScanQueue.filter((item) => item.matched);
  if (validItems.length === 0) {
    showToast("Keine zugeordneten Karten zum Speichern.");
    return;
  }
  const unchecked = autoScanQueue.filter((item) => item.status === "unsure").length;
  if (unchecked > 0 && !confirm(`${unchecked} Karte(n) sind als „nicht sicher“ markiert. Trotzdem so speichern?`)) return;

  const btn = $("#scan-review-save-btn");
  btn.disabled = true;
  btn.textContent = "Speichere …";

  // Gleiche Karte mehrfach im Lauf -> zusammenfassen
  const byId = new Map();
  for (const item of validItems) {
    const entry = byId.get(item.matched.id);
    if (entry) entry.quantity += item.quantity;
    else byId.set(item.matched.id, { card: item.matched, quantity: item.quantity });
  }

  // Dubletten-Schutz wie beim manuellen Speichern: erst per ygo_id, dann per
  // Name bei Karten ohne ygo_id (z.B. aus dem CSV-Import ohne Treffer).
  await refreshMyCardIndex();
  const { data: noIdRows } = await fetchAllRows(() =>
    supabaseClient
      .from("cards")
      .select("id, quantity, name_de, name_en")
      .eq("owner_id", currentSession.user.id)
      .is("ygo_id", null)
      .order("created_at")
      .order("id")
  );
  const findByName = (card) => {
    const de = (card.name_de || "").toLowerCase();
    const en = (card.name_en || "").toLowerCase();
    return (noIdRows || []).find(
      (r) => (de && r.name_de && r.name_de.toLowerCase() === de) || (r.name_en && r.name_en.toLowerCase() === en)
    );
  };

  const toInsert = [];
  const savedIds = new Set(); // bei Teilfehlern nicht erneut speichern
  let updatedCount = 0;
  let firstError = null;
  for (const { card, quantity } of byId.values()) {
    const existing = myCardIndexByYgoId.get(card.id) || findByName(card);
    if (existing) {
      const newQty = existing.quantity + quantity;
      const { error } = await supabaseClient
        .from("cards")
        .update({ quantity: newQty, ygo_id: card.id })
        .eq("id", existing.id);
      if (error) {
        firstError = firstError || error;
        continue;
      }
      updatedCount++;
      savedIds.add(card.id);
      logHistory("update", card.name_de || card.name_en, { cardId: existing.id, qtyBefore: existing.quantity, qtyAfter: newQty });
    } else {
      toInsert.push({
        owner_id: currentSession.user.id,
        ygo_id: card.id,
        name_de: card.name_de,
        name_en: card.name_en,
        card_type: card.type,
        attribute: card.attribute,
        race: card.race,
        atk: card.atk,
        def: card.def,
        level: card.level,
        image_url: card.image,
        quantity,
        effect_text_de: card.desc_de || null,
        effect_text_en: card.desc_en || null,
        archetype: card.archetype || null,
        scale: card.scale ?? null,
      });
    }
  }
  if (toInsert.length) {
    const { error } = await supabaseClient.from("cards").insert(toInsert);
    if (error) firstError = firstError || error;
    else {
      toInsert.forEach((r) => savedIds.add(r.ygo_id));
      logHistory("import", `Auto-Scan: ${toInsert.length} Karten hinzugefügt`, {});
    }
  }

  btn.disabled = false;
  btn.textContent = "Alle bestätigen & speichern";

  if (firstError) {
    // Bereits Gespeichertes aus der Liste nehmen, damit ein erneuter Versuch nichts doppelt addiert
    autoScanQueue = autoScanQueue.filter((q) => !(q.matched && savedIds.has(q.matched.id)));
    renderScanReview();
    showToast("Fehler beim Speichern: " + firstError.message);
    await refreshMyCardIndex();
    return;
  }

  const totalQty = validItems.reduce((sum, i) => sum + i.quantity, 0);
  showToast(`${totalQty}× gespeichert (${toInsert.length} neu, ${updatedCount} Anzahl erhöht)`);

  autoScanQueue = [];
  $("#scan-review").classList.add("hidden");
  resetScan();
  await refreshMyCardIndex();
  renderMineList();
  renderAllList();
}

// ============================================================
// SERVICE WORKER (Installierbarkeit als App)
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

// ============================================================
// START
// ============================================================
initSession();
