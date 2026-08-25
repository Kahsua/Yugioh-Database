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
  });
});

function refreshAllViews() {
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

async function runSearch(query, statusSel, resultsSel) {
  statusSel = statusSel || "#search-status";
  resultsSel = resultsSel || "#search-results";
  $(statusSel).textContent = "Suche läuft …";
  $(resultsSel).innerHTML = "";

  // Suche parallel in Deutsch (übersetzte Namen) und Englisch (kanonische Daten),
  // damit wir für jede Karte beide Namen + zuverlässige Stat-Felder haben.
  const [deResults, enResults] = await Promise.all([
    fetchYgo(query, "de"),
    fetchYgo(query, "en"),
  ]);

  const byId = new Map();
  enResults.forEach((c) => byId.set(c.id, { en: c, de: null }));
  deResults.forEach((c) => {
    if (byId.has(c.id)) byId.get(c.id).de = c;
    else byId.set(c.id, { en: null, de: c });
  });

  const merged = Array.from(byId.values()).map(({ en, de }) => {
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

  if (merged.length === 0) {
    $(statusSel).textContent = "Keine Karten gefunden.";
    return;
  }
  $(statusSel).textContent = `${merged.length} Treffer`;
  renderSearchResults(merged, resultsSel);
}

function renderSearchResults(cards, resultsSel) {
  const grid = $(resultsSel || "#search-results");
  grid.innerHTML = "";
  cards.forEach((card) => {
    const el = document.createElement("div");
    el.className = "result-card";
    el.innerHTML = `
      <img src="${card.image}" alt="${card.name_en}" loading="lazy" />
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
  $("#add-modal").classList.remove("hidden");
}

$("#modal-close").addEventListener("click", () => $("#add-modal").classList.add("hidden"));
$("#add-modal").addEventListener("click", (e) => {
  if (e.target.id === "add-modal") $("#add-modal").classList.add("hidden");
});

$("#modal-save").addEventListener("click", async () => {
  if (!modalCard || !currentSession) return;
  const qty = parseInt($("#modal-qty").value, 10) || 1;
  const btn = $("#modal-save");
  btn.disabled = true;
  const { error } = await supabaseClient.from("cards").insert({
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
  });
  btn.disabled = false;
  if (error) {
    $("#modal-msg").style.color = "var(--danger)";
    $("#modal-msg").textContent = "Fehler: " + error.message;
    return;
  }
  $("#modal-msg").style.color = "var(--spell)";
  $("#modal-msg").textContent = "Zur Sammlung hinzugefügt!";
  showToast(`${qty}× "${modalCard.name_de || modalCard.name_en}" gespeichert`);
  logHistory("add", modalCard.name_de || modalCard.name_en, { qtyAfter: qty });
  renderMineList();
  renderAllList();
  setTimeout(() => $("#add-modal").classList.add("hidden"), 700);
});

// ============================================================
// MEINE SAMMLUNG
// ============================================================
async function renderMineList() {
  if (!supabaseClient || !currentSession) return;
  const { data, error } = await fetchAllRows(() =>
    supabaseClient.from("cards").select("*").eq("owner_id", currentSession.user.id).order("created_at", { ascending: false })
  );

  if (error) {
    $("#mine-list").innerHTML = `<div class="empty-state">Fehler beim Laden: ${error.message}</div>`;
    return;
  }

  populateFilterOptions("#mine-attribute-filter", data, "attribute");
  populateFilterOptionsByCategory("#mine-monster-type-filter", data, "monster", "Monstertyp …");
  populateFilterOptionsByCategory("#mine-spell-type-filter", data, "spell", "Zaubertyp …");
  populateFilterOptionsByCategory("#mine-trap-type-filter", data, "trap", "Fallentyp …");

  const filtered = applyFilters(data, {
    text: $("#mine-filter").value,
    category: $("#mine-category-filter").value,
    attribute: $("#mine-attribute-filter").value,
    monsterType: $("#mine-monster-type-filter").value,
    spellType: $("#mine-spell-type-filter").value,
    trapType: $("#mine-trap-type-filter").value,
  });

  const totalCount = data.reduce((sum, c) => sum + c.quantity, 0);
  $("#mine-count").textContent = `${data.length} Karten · ${totalCount} Exemplare`;

  renderCardList("#mine-list", filtered, { showOwner: false, editable: true });
}

$("#mine-filter").addEventListener("input", debounce(renderMineList, 200));
$("#mine-category-filter").addEventListener("change", renderMineList);
$("#mine-attribute-filter").addEventListener("change", renderMineList);
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
    supabaseClient.from("cards").select("*").order("created_at", { ascending: false })
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

  const filtered = applyFilters(data, {
    text: $("#all-filter").value,
    category: $("#all-category-filter").value,
    attribute: $("#all-attribute-filter").value,
    monsterType: $("#all-monster-type-filter").value,
    spellType: $("#all-spell-type-filter").value,
    trapType: $("#all-trap-type-filter").value,
    owner: ownerSelect.value,
  });

  const totalCount = filtered.reduce((sum, c) => sum + c.quantity, 0);
  $("#all-count").textContent = `${filtered.length} Karten · ${totalCount} Exemplare`;

  renderCardList("#all-list", filtered, { showOwner: true, editable: false });
}

$("#all-filter").addEventListener("input", debounce(renderAllList, 200));
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

function applyFilters(data, { text, category, attribute, monsterType, spellType, trapType, owner }) {
  const textVal = (text || "").toLowerCase();
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
    const matchesOwner = !owner || c.owner_id === owner;
    return (
      matchesText &&
      matchesCategory &&
      matchesAttribute &&
      matchesMonsterType &&
      matchesSpellType &&
      matchesTrapType &&
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
  renderMineList();
  renderAllList();
}

async function deleteCard(card) {
  const { error } = await supabaseClient.from("cards").delete().eq("id", card.id);
  if (error) return showToast("Fehler: " + error.message);
  showToast(`"${card.name_de || card.name_en}" entfernt`);
  logHistory("delete", card.name_de || card.name_en, { qtyBefore: card.quantity });
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
      $("#detail-modal").classList.add("hidden");
    };
    editRow.querySelector('[data-action="dec"]').onclick = () => {
      if (card.quantity <= 1) deleteCard(card);
      else updateQty(card, card.quantity - 1);
      $("#detail-modal").classList.add("hidden");
    };
    editRow.querySelector('[data-action="del"]').onclick = () => {
      deleteCard(card);
      $("#detail-modal").classList.add("hidden");
    };
  }

  $("#detail-modal").classList.remove("hidden");
}

$("#detail-modal-close").addEventListener("click", () => $("#detail-modal").classList.add("hidden"));
$("#detail-modal").addEventListener("click", (e) => {
  if (e.target.id === "detail-modal") $("#detail-modal").classList.add("hidden");
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
    supabaseClient.from("history").select("*").order("created_at", { ascending: false }).limit(300)
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

async function fetchFullYgoDatabase(lang) {
  let url = YGO_API;
  if (lang === "de") url += "?language=de";
  const res = await fetch(url);
  if (!res.ok) throw new Error("YGOPRODeck-Datenbank konnte nicht geladen werden");
  const json = await res.json();
  return json.data || [];
}

$("#import-start-btn").addEventListener("click", runImport);
$("#import-cancel-btn").addEventListener("click", () => {
  importCancelled = true;
});

async function runImport() {
  if (!importRows || !currentSession) return;
  importCancelled = false;
  $("#import-start-btn").disabled = true;
  $("#import-cancel-btn").classList.remove("hidden");
  $("#import-progress-wrap").classList.remove("hidden");
  $("#import-results").classList.add("hidden");
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
    // Duplikate zu erkennen und ggf. fehlende Infos nachzutragen
    statusEl.textContent = "Prüfe vorhandene Sammlung …";
    const { data: existingCards } = await fetchAllRows(() =>
      supabaseClient
        .from("cards")
        .select("id, ygo_id, name_de, name_en, effect_text_de, effect_text_en")
        .eq("owner_id", currentSession.user.id)
    );
    const existingByKey = new Map(
      (existingCards || []).map((c) => [
        c.ygo_id ? "id:" + c.ygo_id : "name:" + normalizeName(c.name_de || c.name_en),
        c,
      ])
    );

    // Schritt 3: jede Zeile matchen
    const toInsert = [];
    const toEnrich = [];
    const notFound = [];
    let skipped = 0;

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
        skipped++;
        // Fehlende Zusatzinfos (z.B. Kartentext) bei bereits vorhandenen Karten nachtragen
        const missingDe = !existing.effect_text_de && deMatch && deMatch.desc;
        const missingEn = !existing.effect_text_en && matched && matched.desc;
        if (missingDe || missingEn) {
          toEnrich.push({
            id: existing.id,
            effect_text_de: missingDe ? deMatch.desc : existing.effect_text_de,
            effect_text_en: missingEn ? matched.desc : existing.effect_text_en,
            archetype: matched ? matched.archetype || null : null,
            scale: matched ? matched.scale ?? null : null,
            image_url: matched && matched.card_images && matched.card_images[0] ? matched.card_images[0].image_url : null,
            ygo_id: matched ? matched.id : null,
          });
        }
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
        const pct = 15 + Math.round((i / importRows.length) * 55);
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

    // Schritt 4: neue Karten in Batches speichern
    fillEl.style.width = "70%";
    statusEl.textContent = `Speichere ${toInsert.length} neue Karten …`;
    const batchSize = 200;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      if (batch.length === 0) continue;
      const { error } = await supabaseClient.from("cards").insert(batch);
      if (error) throw new Error("Fehler beim Speichern: " + error.message);
      const pct = 70 + Math.round(((i + batch.length) / Math.max(toInsert.length, 1)) * 15);
      fillEl.style.width = pct + "%";
      statusEl.textContent = `Speichere … (${Math.min(i + batch.length, toInsert.length)}/${toInsert.length})`;
    }

    // Schritt 5: fehlende Infos bei bereits vorhandenen Karten ergänzen
    if (toEnrich.length > 0) {
      statusEl.textContent = `Ergänze Kartentext bei ${toEnrich.length} bereits vorhandenen Karten …`;
      for (let i = 0; i < toEnrich.length; i++) {
        const e = toEnrich[i];
        await supabaseClient
          .from("cards")
          .update({
            effect_text_de: e.effect_text_de,
            effect_text_en: e.effect_text_en,
            archetype: e.archetype,
            scale: e.scale,
            image_url: e.image_url,
            ygo_id: e.ygo_id,
          })
          .eq("id", e.id);
        if (i % 50 === 0) {
          const pct = 85 + Math.round((i / toEnrich.length) * 15);
          fillEl.style.width = pct + "%";
        }
      }
    }

    fillEl.style.width = "100%";
    statusEl.textContent = "Import abgeschlossen!";
    showResults(toInsert.length, skipped, notFound, toEnrich.length);
    logHistory("import", `CSV-Import: ${toInsert.length} neu, ${toEnrich.length} ergänzt`, {});
    renderMineList();
    renderAllList();
  } catch (err) {
    statusEl.textContent = "Fehler: " + err.message;
  } finally {
    $("#import-cancel-btn").classList.add("hidden");
    $("#import-start-btn").disabled = false;
  }
}

function parseIntOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = v.toString().trim();
  if (s === "" || s === "-" || s === "?") return null;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function showResults(insertedCount, skippedCount, notFound, enrichedCount) {
  const el = $("#import-results");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="import-results-grid">
      <div class="import-stat"><div class="num">${insertedCount}</div><div class="label">neu importiert</div></div>
      <div class="import-stat"><div class="num">${skippedCount}</div><div class="label">bereits vorhanden</div></div>
      <div class="import-stat"><div class="num">${enrichedCount || 0}</div><div class="label">Kartentext ergänzt</div></div>
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
  showToast(`Import fertig: ${insertedCount} neue Karten gespeichert`);
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
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch (err) {
    $("#scan-status").textContent =
      "Kamera-Zugriff nicht möglich (" + err.message + "). Bitte Kamera-Berechtigung im Browser erlauben.";
    return null;
  }
  const video = $("#scan-video");
  video.srcObject = scanStream;
  video.classList.remove("hidden");
  $("#scan-placeholder").classList.add("hidden");
  $("#scan-card-guide").classList.remove("hidden");
  $("#scan-start-btn").classList.add("hidden");
  $("#scan-capture-btn").classList.remove("hidden");
  $("#scan-status").textContent = "Karte im Rahmen ausrichten, dann Foto aufnehmen.";
  return scanStream;
}

function stopScanCamera() {
  if (scanStream) {
    scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
}

// ============================================================
// BILDAUSSCHNITT & VORVERARBEITUNG (für bessere Texterkennung)
// ============================================================

// Der Kartenname steht bei Yu-Gi-Oh-Karten immer im selben Bereich oben auf
// der Karte. Statt das ganze Kamerabild (inkl. Hintergrund) zu erkennen,
// schneiden wir gezielt nur diesen Bereich aus - das ist der größte
// Genauigkeits-Hebel.
const NAME_BAND = { x0: 0.04, x1: 0.8, y0: 0.02, y1: 0.078 };

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

// Schneidet aus dem Live-Video genau den Bereich innerhalb des
// Ausrichtrahmens aus - das Ergebnis ist (bei korrekter Ausrichtung) exakt
// die fotografierte Karte, ohne Hintergrund.
function captureCardCanvas() {
  const video = $("#scan-video");
  const guide = $("#scan-card-guide");
  const videoRect = video.getBoundingClientRect();
  const guideRect = guide.getBoundingClientRect();
  const { sx, sy, sw, sh } = getCoverSourceRect(video, guideRect, videoRect);

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  canvas.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function extractNameBand(cardCanvas) {
  const x = Math.round(cardCanvas.width * NAME_BAND.x0);
  const y = Math.round(cardCanvas.height * NAME_BAND.y0);
  const w = Math.round(cardCanvas.width * (NAME_BAND.x1 - NAME_BAND.x0));
  const h = Math.round(cardCanvas.height * (NAME_BAND.y1 - NAME_BAND.y0));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, w);
  canvas.height = Math.max(1, h);
  canvas.getContext("2d").drawImage(cardCanvas, x, y, w, h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Vergrößert den Ausschnitt, wandelt ihn in Graustufen um und binarisiert ihn
// (Otsu-Schwellenwert) zu reinem Schwarz/Weiß. Erkennt automatisch, ob der
// Kartenname hell-auf-dunkel (die meisten Kartentypen) oder dunkel-auf-hell
// (z.B. Synchro-Karten) gedruckt ist, und normalisiert auf ein einheitliches
// Format - das verbessert die Texterkennung erheblich gegenüber rohen
// Kamerabildern mit Farbverläufen.
function preprocessForOcr(sourceCanvas, targetHeight = 140) {
  const scale = targetHeight / sourceCanvas.height;
  const w = Math.max(1, Math.round(sourceCanvas.width * scale));
  const h = targetHeight;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;
  const n = w * h;
  const gray = new Uint8ClampedArray(n);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    gray[p] = g;
    hist[g]++;
  }

  // Otsu-Schwellenwert: findet automatisch den besten Trennwert zwischen Text und Hintergrund
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0,
    wB = 0,
    maxVar = 0,
    threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshold = t;
    }
  }

  let darkCount = 0;
  for (let p = 0; p < n; p++) if (gray[p] < threshold) darkCount++;
  const invert = darkCount > n / 2; // Mehrheit dunkel -> invertieren, damit Ergebnis dunkler Text auf hellem Grund ist

  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let v = gray[p] < threshold ? 0 : 255;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return out;
}

async function recognizeText(canvas, psm) {
  const worker = await getOcrWorker();
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const {
    data: { text },
  } = await worker.recognize(canvas);
  return text || "";
}

async function captureAndRecognize() {
  const cardCanvas = captureCardCanvas();
  $("#scan-captured-img").src = cardCanvas.toDataURL("image/jpeg", 0.9);
  $("#scan-captured-img").classList.remove("hidden");
  $("#scan-video").classList.add("hidden");
  $("#scan-card-guide").classList.add("hidden");
  stopScanCamera();

  $("#scan-capture-btn").classList.add("hidden");
  $("#scan-retry-btn").classList.remove("hidden");
  $("#scan-status").textContent = "Erkenne Text … (beim ersten Mal dauert das Laden der Erkennung etwas länger)";

  try {
    // 1. Versuch: nur der Namensbereich, als Einzelzeile erkannt (schnell & präzise)
    const nameBand = extractNameBand(cardCanvas);
    const processedBand = preprocessForOcr(nameBand);

    // Diagnose-Vorschau: zeigt exakt das Bild, das an die Texterkennung geht
    $("#scan-debug-img").src = processedBand.toDataURL("image/png");
    $("#scan-debug").classList.remove("hidden");

    let text = await recognizeText(processedBand, "7"); // PSM 7 = einzelne Textzeile
    let guess = extractLikelyCardName(text);

    // 2. Fallback: ganze Karte, falls im Namensbereich nichts Brauchbares gefunden wurde
    // (z.B. weil die Ausrichtung nicht exakt genug war)
    if (!guess) {
      const processedFull = preprocessForOcr(cardCanvas, 220);
      $("#scan-debug-img").src = processedFull.toDataURL("image/png");
      text = await recognizeText(processedFull, "6"); // PSM 6 = einheitlicher Textblock
      guess = extractLikelyCardName(text);
    }

    $("#scan-name-row").classList.remove("hidden");
    $("#scan-name-input").value = guess;

    if (guess) {
      $("#scan-status").textContent = "Text erkannt – bitte prüfen und die richtige Karte auswählen:";
      fuzzySearchAndRender(guess, "#scan-results", "#scan-search-status");
    } else {
      $("#scan-status").textContent = "Kein eindeutiger Text erkannt. Bitte Namen manuell eingeben.";
    }
  } catch (err) {
    $("#scan-status").textContent = "Fehler bei der Texterkennung: " + err.message;
    $("#scan-name-row").classList.remove("hidden");
  }
}

async function getOcrWorker() {
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker("eng+deu");
  return ocrWorker;
}

// Nimmt die erste brauchbar lange Zeile aus dem OCR-Ergebnis und säubert sie
// von Störzeichen (Umlaute/Sonderzeichen im Kartennamen bleiben erhalten).
function extractLikelyCardName(rawText) {
  const lines = (rawText || "")
    .split("\n")
    .map((l) => l.replace(/[^\p{L}\p{N}\s\-,'"!.]/gu, "").trim())
    .filter((l) => l.length >= 3);
  return lines.length > 0 ? lines[0] : "";
}

function resetScan() {
  stopScanCamera();
  $("#scan-video").classList.add("hidden");
  $("#scan-captured-img").classList.add("hidden");
  $("#scan-card-guide").classList.add("hidden");
  $("#scan-placeholder").classList.remove("hidden");
  $("#scan-start-btn").classList.remove("hidden");
  $("#scan-capture-btn").classList.add("hidden");
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
  $("#auto-scan-start-btn").classList.remove("hidden");
  $("#auto-scan-stop-btn").classList.add("hidden");
}

// ============================================================
// AUTO-SCAN (Serienerfassung per Bewegungserkennung)
// ============================================================
let autoScanQueue = []; // {id, thumb, guess, matched, quantity, status}
let motionInterval = null;
let motionSmallCanvas = document.createElement("canvas");
motionSmallCanvas.width = 48;
motionSmallCanvas.height = 48;
let lastSmallFrameData = null;
let stillFrameCount = 0;
let capturedForCurrentObject = false;
let ocrChain = Promise.resolve(); // serialisiert OCR-Aufrufe (ein Worker kann nur 1 gleichzeitig)

const STILL_THRESHOLD = 6; // Grauwert-Differenz unterhalb: "ruhig"
const MOVE_THRESHOLD = 14; // oberhalb: "in Bewegung" (Hysterese gegen Flackern)
const REQUIRED_STILL_TICKS = 3; // ~3 x 350ms = guten 1 Sek. Ruhe nötig vor Auslösen
const MOTION_TICK_MS = 350;

$("#auto-scan-start-btn").addEventListener("click", startAutoScan);
$("#auto-scan-stop-btn").addEventListener("click", stopAutoScanAndReview);
$("#scan-review-save-btn").addEventListener("click", saveAutoScanQueue);
$("#scan-review-discard-btn").addEventListener("click", () => {
  autoScanQueue = [];
  $("#scan-review").classList.add("hidden");
  resetScan();
});

async function startAutoScan() {
  autoScanQueue = [];
  lastSmallFrameData = null;
  stillFrameCount = 0;
  capturedForCurrentObject = false;
  renderScanQueue();

  const stream = await startScanCamera();
  if (!stream) return;

  $("#auto-scan-start-btn").classList.add("hidden");
  $("#auto-scan-stop-btn").classList.remove("hidden");
  $("#scan-capture-btn").classList.add("hidden"); // Auto-Scan löst selbst aus
  $("#scan-queue").classList.remove("hidden");
  $("#scan-status").textContent = "Auto-Scan läuft – Karten nacheinander in den Kamerabereich legen.";

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
}

function stopAutoScanAndReview() {
  stopAutoScan();
  $("#scan-video").classList.add("hidden");
  $("#scan-card-guide").classList.add("hidden");
  $("#scan-placeholder").classList.remove("hidden");
  $("#auto-scan-start-btn").classList.remove("hidden");
  $("#auto-scan-stop-btn").classList.add("hidden");
  showScanReview();
}

function checkMotionTick() {
  const video = $("#scan-video");
  const guide = $("#scan-card-guide");
  if (!video.videoWidth) return;

  const videoRect = video.getBoundingClientRect();
  const guideRect = guide.getBoundingClientRect();
  const { sx, sy, sw, sh } = getCoverSourceRect(video, guideRect, videoRect);

  const ctx = motionSmallCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, motionSmallCanvas.width, motionSmallCanvas.height);
  const frame = ctx.getImageData(0, 0, motionSmallCanvas.width, motionSmallCanvas.height).data;

  if (lastSmallFrameData) {
    let diffSum = 0;
    const pixelCount = frame.length / 4;
    for (let i = 0; i < frame.length; i += 4) {
      const gray1 = (frame[i] + frame[i + 1] + frame[i + 2]) / 3;
      const gray2 = (lastSmallFrameData[i] + lastSmallFrameData[i + 1] + lastSmallFrameData[i + 2]) / 3;
      diffSum += Math.abs(gray1 - gray2);
    }
    const avgDiff = diffSum / pixelCount;

    if (avgDiff > MOVE_THRESHOLD) {
      stillFrameCount = 0;
      capturedForCurrentObject = false;
      $("#scan-motion-badge").classList.add("hidden");
    } else if (avgDiff < STILL_THRESHOLD) {
      stillFrameCount++;
      if (stillFrameCount >= REQUIRED_STILL_TICKS && !capturedForCurrentObject) {
        capturedForCurrentObject = true;
        $("#scan-motion-badge").classList.add("hidden");
        captureForAutoScan();
      } else if (!capturedForCurrentObject) {
        $("#scan-motion-badge").classList.remove("hidden");
      }
    }
  }
  lastSmallFrameData = frame;
}

function captureForAutoScan() {
  const cardCanvas = captureCardCanvas();
  const thumb = cardCanvas.toDataURL("image/jpeg", 0.75);

  const item = {
    id: "s" + Date.now() + Math.random().toString(36).slice(2, 7),
    thumb,
    guess: "",
    matched: null,
    quantity: 1,
    status: "ocr",
  };
  autoScanQueue.push(item);
  renderScanQueue();

  ocrChain = ocrChain.then(() => processAutoScanItem(item, cardCanvas)).catch(() => {});
}

async function processAutoScanItem(item, cardCanvas) {
  try {
    // 1. Versuch: nur der Namensbereich, als Einzelzeile
    const nameBand = extractNameBand(cardCanvas);
    const processedBand = preprocessForOcr(nameBand);
    let text = await recognizeText(processedBand, "7");
    item.guess = extractLikelyCardName(text);

    // 2. Fallback: ganze Karte, falls nichts gefunden
    if (!item.guess) {
      const processedFull = preprocessForOcr(cardCanvas, 220);
      text = await recognizeText(processedFull, "6");
      item.guess = extractLikelyCardName(text);
    }

    item.status = "searching";
    renderScanQueue();

    if (item.guess) {
      const match = await fuzzyTopMatch(item.guess);
      if (match) {
        // Wurde dieselbe Karte gerade schon gescannt? Dann Anzahl statt neuer Zeile erhöhen.
        const existing = autoScanQueue.find((q) => q.id !== item.id && q.matched && q.matched.id === match.id);
        if (existing) {
          existing.quantity++;
          autoScanQueue = autoScanQueue.filter((q) => q.id !== item.id);
          renderScanQueue();
          return;
        }
        item.matched = match;
        item.status = "matched";
      } else {
        item.status = "nomatch";
      }
    } else {
      item.status = "nomatch";
    }
  } catch (err) {
    item.status = "error";
  }
  renderScanQueue();
}

// Liefert den wahrscheinlichsten Treffer für einen (evtl. unscharfen) OCR-Namen.
// (Wird als Fallback genutzt, falls die lokale Kartendatenbank noch nicht geladen ist.)
async function searchTopCandidate(query) {
  const [deResults, enResults] = await Promise.all([fetchYgo(query, "de"), fetchYgo(query, "en")]);
  const all = [...deResults, ...enResults];
  if (all.length === 0) return null;

  const qLower = query.trim().toLowerCase();
  const exact = all.find((c) => c.name.toLowerCase() === qLower);
  const best = exact || all[0];

  const enMatch = enResults.find((c) => c.id === best.id) || (best.id ? enResults[0] : null);
  const deMatch = deResults.find((c) => c.id === best.id);
  const canonical = enMatch || best;

  return {
    id: canonical.id,
    name_en: enMatch ? enMatch.name : canonical.name,
    name_de: deMatch ? deMatch.name : null,
    type: canonical.type,
    race: canonical.race,
    attribute: canonical.attribute,
    atk: canonical.atk,
    def: canonical.def,
    level: canonical.level ?? canonical.linkval,
    archetype: canonical.archetype || null,
    scale: canonical.scale ?? null,
    desc_de: deMatch ? deMatch.desc : null,
    desc_en: enMatch ? enMatch.desc : canonical.desc,
    image: canonical.card_images && canonical.card_images[0] ? canonical.card_images[0].image_url : "",
  };
}

// ============================================================
// UNSCHARFER (TIPPFEHLER-TOLERANTER) ABGLEICH GEGEN DIE GESAMTE
// KARTENDATENBANK - deutlich robuster für OCR-Ergebnisse als eine exakte
// API-Suche, weil erkannter Text fast nie 100% korrekt ist.
// ============================================================
let cardDbEn = null;
let cardDbDe = null;
let cardDbEnById = null;
let cardDbDeById = null;
let cardDbLoadPromise = null;

function ensureCardDbLoaded() {
  if (cardDbEn && cardDbDe) return Promise.resolve();
  if (cardDbLoadPromise) return cardDbLoadPromise;

  cardDbLoadPromise = (async () => {
    const [en, de] = await Promise.all([fetchFullYgoDatabase("en"), fetchFullYgoDatabase("de")]);
    cardDbEn = en;
    cardDbDe = de;
    cardDbEnById = new Map(en.map((c) => [c.id, c]));
    cardDbDeById = new Map(de.map((c) => [c.id, c]));
  })();
  return cardDbLoadPromise;
}

// Klassische Levenshtein-Distanz (Anzahl Einfüge-/Lösch-/Ersetz-Operationen).
function levenshtein(a, b) {
  const al = a.length,
    bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[bl];
}

// Ähnlichkeit 0..1 (1 = identisch). Teilstring-Treffer bekommen einen Bonus,
// damit auch nur teilweise erkannter Text (abgeschnittene Zeile o.ä.) gut abschneidet.
function nameSimilarity(query, name) {
  const q = query.toLowerCase().trim();
  const n = name.toLowerCase().trim();
  if (!q || !n) return 0;
  const dist = levenshtein(q, n);
  let score = 1 - dist / Math.max(q.length, n.length, 1);
  if (n.includes(q) || q.includes(n)) score = Math.max(score, 0.72);
  return score;
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

// Findet die besten Kandidaten-IDs für einen (evtl. fehlerhaften) Namen,
// sortiert nach Ähnlichkeit, über Deutsch UND Englisch hinweg.
function fuzzyFindCandidateIds(query, limit = 5) {
  const q = (query || "").trim();
  if (!q || !cardDbEn || !cardDbDe) return [];

  const bestById = new Map();
  const consider = (card) => {
    const score = nameSimilarity(q, card.name);
    const existing = bestById.get(card.id);
    if (!existing || score > existing) bestById.set(card.id, score);
  };
  cardDbEn.forEach(consider);
  cardDbDe.forEach(consider);

  return Array.from(bestById.entries())
    .filter(([, score]) => score > 0.3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

// Unscharfe Suche + Anzeige als Ergebnis-Kacheln (nutzt im Hintergrund die
// lokale Datenbank; lädt sie bei Bedarf einmalig nach).
async function fuzzySearchAndRender(query, resultsSel, statusSel) {
  $(statusSel).textContent = "Suche ähnliche Karten …";
  $(resultsSel).innerHTML = "";

  await ensureCardDbLoaded();
  const ids = fuzzyFindCandidateIds(query, 6);
  const cards = ids.map(buildMergedCardById).filter(Boolean);

  if (cards.length === 0) {
    $(statusSel).textContent = "Keine ähnlichen Karten gefunden. Bitte Namen manuell korrigieren.";
    return;
  }
  $(statusSel).textContent = `${cards.length} mögliche Treffer (nach Ähnlichkeit sortiert) - bitte die richtige Karte auswählen:`;
  renderSearchResults(cards, resultsSel);
}

// Bester unscharfer Treffer für den Auto-Scan (ohne Nutzerinteraktion mitten im Lauf).
async function fuzzyTopMatch(query) {
  await ensureCardDbLoaded();
  const ids = fuzzyFindCandidateIds(query, 1);
  return ids.length > 0 ? buildMergedCardById(ids[0]) : null;
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
    if (item.status === "ocr" || item.status === "searching") statusHtml = `<div class="status-badge">⏳</div>`;
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
    row.className = "scan-review-row";
    const img = item.matched ? item.matched.image : item.thumb;
    const nameVal = item.matched ? item.matched.name_de || item.matched.name_en : item.guess;
    const metaText = item.matched
      ? [item.matched.card_type, item.matched.attribute].filter(Boolean).join(" · ")
      : item.status === "nomatch"
      ? "Keine automatische Zuordnung gefunden – Name prüfen und erneut suchen"
      : "Wird erkannt …";

    row.innerHTML = `
      <img src="${img}" alt="" />
      <div class="review-main">
        <input type="text" class="review-name-input" value="${nameVal || ""}" placeholder="Kartenname …" />
        <span class="review-meta">${metaText}</span>
      </div>
      <input type="number" class="review-qty" min="1" max="99" value="${item.quantity}" />
      <button class="icon-btn" data-action="research" title="Erneut suchen">🔍</button>
      <button class="icon-btn danger" data-action="remove" title="Entfernen">🗑</button>
    `;

    row.querySelector(".review-qty").addEventListener("change", (e) => {
      item.quantity = parseInt(e.target.value, 10) || 1;
    });
    row.querySelector('[data-action="remove"]').addEventListener("click", () => {
      autoScanQueue = autoScanQueue.filter((q) => q.id !== item.id);
      renderScanReview();
    });
    row.querySelector('[data-action="research"]').addEventListener("click", async () => {
      const newName = row.querySelector(".review-name-input").value.trim();
      if (!newName) return;
      row.querySelector(".review-meta").textContent = "Suche …";
      const match = await fuzzyTopMatch(newName);
      if (match) {
        item.matched = match;
        item.status = "matched";
      } else {
        item.matched = null;
        item.status = "nomatch";
      }
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

  $("#scan-review-save-btn").disabled = true;
  $("#scan-review-save-btn").textContent = "Speichere …";

  const rows = validItems.map((item) => ({
    owner_id: currentSession.user.id,
    ygo_id: item.matched.id,
    name_de: item.matched.name_de,
    name_en: item.matched.name_en,
    card_type: item.matched.type,
    attribute: item.matched.attribute,
    race: item.matched.race,
    atk: item.matched.atk,
    def: item.matched.def,
    level: item.matched.level,
    image_url: item.matched.image,
    quantity: item.quantity,
    effect_text_de: item.matched.desc_de || null,
    effect_text_en: item.matched.desc_en || null,
    archetype: item.matched.archetype || null,
    scale: item.matched.scale ?? null,
  }));

  const { error } = await supabaseClient.from("cards").insert(rows);

  $("#scan-review-save-btn").disabled = false;
  $("#scan-review-save-btn").textContent = "Alle bestätigen & speichern";

  if (error) {
    showToast("Fehler beim Speichern: " + error.message);
    return;
  }

  const totalQty = validItems.reduce((sum, i) => sum + i.quantity, 0);
  showToast(`${validItems.length} Karten (${totalQty}× insgesamt) gespeichert`);
  logHistory("import", `Auto-Scan: ${validItems.length} Karten hinzugefügt`, {});

  autoScanQueue = [];
  $("#scan-review").classList.add("hidden");
  resetScan();
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
