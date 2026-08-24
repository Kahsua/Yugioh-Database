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
    $all(".view").forEach((v) => v.classList.remove("active"));
    $("#view-" + view).classList.add("active");
    if (view === "mine") renderMineList();
    if (view === "all") renderAllList();
    if (view === "history") renderHistory();
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

async function runSearch(query) {
  $("#search-status").textContent = "Suche läuft …";
  $("#search-results").innerHTML = "";

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
    $("#search-status").textContent = "Keine Karten gefunden.";
    return;
  }
  $("#search-status").textContent = `${merged.length} Treffer`;
  renderSearchResults(merged);
}

function renderSearchResults(cards) {
  const grid = $("#search-results");
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
// START
// ============================================================
initSession();
