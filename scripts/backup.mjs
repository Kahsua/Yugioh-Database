// ============================================================
// Backup der Supabase-Daten (profiles, cards, history) nach backup/
// ============================================================
// Lokal:   node scripts/backup.mjs        (liest Zugangsdaten aus config.js)
// GitHub:  läuft wöchentlich über .github/workflows/backup.yml
//          (Zugangsdaten aus den Secrets SUPABASE_URL / SUPABASE_ANON_KEY),
//          dort anschließend mit scripts/backup-crypt.mjs verschlüsselt.
//
// Die Daten in backup/ sind per .gitignore vom Repo ausgeschlossen –
// nur last-backup.json (Zeitstempel + Zeilenzahlen) wird committet.
//
// Liest nur, was der öffentliche anon-Key per RLS lesen darf – das sind
// alle drei Tabellen komplett. Benutzerkonten (E-Mail/Passwort) sind NICHT
// enthalten, die liegen in auth.users und sind von außen nicht lesbar.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "backup");
const PAGE_SIZE = 1000; // Supabase liefert max. 1000 Zeilen pro Anfrage
const TABLES = ["profiles", "cards", "history"];

function loadCredentials() {
  let url = process.env.SUPABASE_URL;
  let key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    const config = readFileSync(join(ROOT, "config.js"), "utf8");
    url ||= config.match(/SUPABASE_URL:\s*"([^"]+)"/)?.[1];
    key ||= config.match(/SUPABASE_ANON_KEY:\s*"([^"]+)"/)?.[1];
  }
  if (!url || !key) throw new Error("Supabase-Zugangsdaten fehlen (Env oder config.js).");
  return { url: url.replace(/\/+$/, ""), key };
}

async function fetchTable({ url, key }, table) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const res = await fetch(
      `${url}/rest/v1/${table}?select=*&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

function toCsv(rows) {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => escape(r[c])).join(","))].join("\n") + "\n";
}

const creds = loadCredentials();
mkdirSync(OUT_DIR, { recursive: true });

const summary = {};
for (const table of TABLES) {
  const rows = await fetchTable(creds, table);
  writeFileSync(join(OUT_DIR, `${table}.json`), JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(join(OUT_DIR, `${table}.csv`), toCsv(rows));
  summary[table] = rows.length;
}

// Zeitstempel ändert sich bei jedem Lauf -> es gibt immer einen Commit,
// dadurch bleibt der GitHub-Zeitplan aktiv (wird sonst nach 60 Tagen ohne
// Commit abgeschaltet).
writeFileSync(
  join(OUT_DIR, "last-backup.json"),
  JSON.stringify({ created_at: new Date().toISOString(), rows: summary }, null, 2) + "\n"
);

console.log("Backup erstellt:", summary);
