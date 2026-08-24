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

  const { data, error } = await supabaseClient.auth.signUp({ email, password });
  if (error) {
    $("#signup-error").textContent = "Registrierung fehlgeschlagen: " + error.message;
    return;
  }

  // Falls E-Mail-Bestätigung deaktiviert ist, existiert sofort eine Session.
  if (data.user) {
    const { error: profileError } = await supabaseClient
      .from("profiles")
      .insert({ id: data.user.id, username });
    if (profileError && !profileError.message.includes("duplicate")) {
      $("#signup-error").textContent = "Konto erstellt, aber Profil-Fehler: " + profileError.message;
    }
  }

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
      desc: (de || en).desc,
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
  $("#modal-desc").textContent = card.desc || "";
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
  renderMineList();
  renderAllList();
  setTimeout(() => $("#add-modal").classList.add("hidden"), 700);
});

// ============================================================
// MEINE SAMMLUNG
// ============================================================
async function renderMineList() {
  if (!supabaseClient || !currentSession) return;
  const { data, error } = await supabaseClient
    .from("cards")
    .select("*")
    .eq("owner_id", currentSession.user.id)
    .order("created_at", { ascending: false });

  if (error) {
    $("#mine-list").innerHTML = `<div class="empty-state">Fehler beim Laden: ${error.message}</div>`;
    return;
  }

  const filterVal = ($("#mine-filter").value || "").toLowerCase();
  const filtered = data.filter(
    (c) =>
      (c.name_de || "").toLowerCase().includes(filterVal) ||
      (c.name_en || "").toLowerCase().includes(filterVal)
  );

  const totalCount = data.reduce((sum, c) => sum + c.quantity, 0);
  $("#mine-count").textContent = `${data.length} Karten · ${totalCount} Exemplare`;

  renderCardList("#mine-list", filtered, { showOwner: false, editable: true });
}

$("#mine-filter").addEventListener("input", debounce(renderMineList, 200));

// ============================================================
// ALLE SAMMLUNGEN
// ============================================================
async function renderAllList() {
  if (!supabaseClient) return;
  await loadAllProfiles();

  const { data, error } = await supabaseClient
    .from("cards")
    .select("*")
    .order("created_at", { ascending: false });

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

  const filterVal = ($("#all-filter").value || "").toLowerCase();
  const ownerVal = ownerSelect.value;

  const filtered = data.filter((c) => {
    const matchesText =
      (c.name_de || "").toLowerCase().includes(filterVal) ||
      (c.name_en || "").toLowerCase().includes(filterVal);
    const matchesOwner = !ownerVal || c.owner_id === ownerVal;
    return matchesText && matchesOwner;
  });

  const totalCount = filtered.reduce((sum, c) => sum + c.quantity, 0);
  $("#all-count").textContent = `${filtered.length} Karten · ${totalCount} Exemplare`;

  renderCardList("#all-list", filtered, { showOwner: true, editable: false });
}

$("#all-filter").addEventListener("input", debounce(renderAllList, 200));
$("#all-owner-filter").addEventListener("change", renderAllList);

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
      row.querySelector('[data-action="inc"]').addEventListener("click", () => updateQty(card, card.quantity + 1));
      row.querySelector('[data-action="dec"]').addEventListener("click", () => {
        if (card.quantity <= 1) return deleteCard(card);
        updateQty(card, card.quantity - 1);
      });
      row.querySelector('[data-action="del"]').addEventListener("click", () => deleteCard(card));
    }

    container.appendChild(row);
  });
}

async function updateQty(card, newQty) {
  const { error } = await supabaseClient.from("cards").update({ quantity: newQty }).eq("id", card.id);
  if (error) return showToast("Fehler: " + error.message);
  renderMineList();
  renderAllList();
}

async function deleteCard(card) {
  const { error } = await supabaseClient.from("cards").delete().eq("id", card.id);
  if (error) return showToast("Fehler: " + error.message);
  showToast(`"${card.name_de || card.name_en}" entfernt`);
  renderMineList();
  renderAllList();
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
    const deIdByName = new Map();
    deCards.forEach((c) => deIdByName.set(normalizeName(c.name), c.id));

    fillEl.style.width = "15%";

    // Schritt 2: bereits vorhandene Karten des Nutzers laden, um Duplikate zu vermeiden
    statusEl.textContent = "Prüfe vorhandene Sammlung …";
    const { data: existingCards } = await supabaseClient
      .from("cards")
      .select("ygo_id, name_de, name_en")
      .eq("owner_id", currentSession.user.id);
    const existingKeys = new Set(
      (existingCards || []).map((c) => (c.ygo_id ? "id:" + c.ygo_id : "name:" + normalizeName(c.name_de || c.name_en)))
    );

    // Schritt 3: jede Zeile matchen
    const toInsert = [];
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
      if (existingKeys.has(key)) {
        skipped++;
        continue;
      }
      existingKeys.add(key);

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

    // Schritt 4: in Batches in Supabase speichern
    fillEl.style.width = "75%";
    statusEl.textContent = `Speichere ${toInsert.length} Karten in deiner Sammlung …`;
    const batchSize = 200;
    for (let i = 0; i < toInsert.length; i += batchSize) {
      const batch = toInsert.slice(i, i + batchSize);
      if (batch.length === 0) continue;
      const { error } = await supabaseClient.from("cards").insert(batch);
      if (error) throw new Error("Fehler beim Speichern: " + error.message);
      const pct = 75 + Math.round(((i + batch.length) / Math.max(toInsert.length, 1)) * 25);
      fillEl.style.width = pct + "%";
      statusEl.textContent = `Speichere … (${Math.min(i + batch.length, toInsert.length)}/${toInsert.length})`;
    }

    fillEl.style.width = "100%";
    statusEl.textContent = "Import abgeschlossen!";
    showResults(toInsert.length, skipped, notFound);
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

function showResults(insertedCount, skippedCount, notFound) {
  const el = $("#import-results");
  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="import-results-grid">
      <div class="import-stat"><div class="num">${insertedCount}</div><div class="label">neu importiert</div></div>
      <div class="import-stat"><div class="num">${skippedCount}</div><div class="label">bereits vorhanden</div></div>
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
