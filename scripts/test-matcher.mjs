// ============================================================
// Offline-Test für den Kartenabgleich der Scan-Engine
// ============================================================
// Simuliert OCR-Fehler auf echten Kartennamen/-codes und misst, wie oft die
// richtige Karte gefunden wird - einmal mit dem alten Abgleich (bis v15),
// einmal mit scan-engine.js.
//
// Aufruf:  node scripts/test-matcher.mjs [Ordner mit en.json/de.json] [Anzahl]
// Ohne Ordner wird die Kartendatenbank von YGOPRODeck geladen.
// ============================================================

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Engine = require("../scan-engine.js");

const [dbDir, countArg] = process.argv.slice(2);
const SAMPLES = parseInt(countArg || "400", 10);

async function loadDb(lang) {
  const file = dbDir && join(dbDir, `${lang}.json`);
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).data;
  const url = "https://db.ygoprodeck.com/api/v7/cardinfo.php" + (lang === "de" ? "?language=de" : "");
  return (await (await fetch(url)).json()).data;
}

// Reproduzierbarer Zufall
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const CONFUSE = { o: "0", l: "1", i: "l", s: "5", b: "8", e: "c", a: "o", n: "h", u: "v", rn: "m", m: "rn", c: "e" };
const GARBAGE = ["©", "|", "'", "DARK", "LICHT", ")", "—", "®", ".", "ii", "FEUER", "~"];

function ocrNoise(name, level) {
  const p = level === "heavy" ? 0.1 : 0.04;
  let s = name;
  if (rand() < 0.5) s = s.replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/Ä/g, "A").replace(/Ö/g, "O").replace(/Ü/g, "U");
  let out = "";
  for (const ch of s) {
    const r = rand();
    const low = ch.toLowerCase();
    if (r < p && CONFUSE[low]) out += CONFUSE[low];
    else if (r < p * 1.6) out += String.fromCharCode(97 + Math.floor(rand() * 26));
    else if (r < p * 2) continue; // Zeichen verschluckt
    else if (r < p * 2.3) out += ch + ch; // doppelt
    else out += ch;
  }
  if (rand() < 0.4) out = pick(GARBAGE) + " " + out;
  if (rand() < 0.5) out = out + " " + pick(GARBAGE);
  if (level === "heavy" && rand() < 0.15) out = out.slice(0, Math.ceil(out.length * 0.75)); // abgeschnitten
  if (rand() < 0.2) out = out.replace(/ /g, "");
  return out;
}

function codeNoise(code) {
  // Set-Code: deutsche Region statt EN, gelegentliche O/0-, I/1-Fehler
  let c = code.replace(/-EN/, "-DE");
  if (rand() < 0.2) c = c.replace(/0/, "O");
  if (rand() < 0.1) c = c.replace(/1/, "I");
  return "x " + c + " ~";
}

// ---------- Alter Abgleich (bis v15), zum Vergleich ----------
function levenshtein(a, b) {
  const al = a.length, bl = b.length;
  if (!al) return bl;
  if (!bl) return al;
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
function oldSimilarity(query, name) {
  const q = query.toLowerCase().trim(), n = name.toLowerCase().trim();
  if (!q || !n) return 0;
  let score = 1 - levenshtein(q, n) / Math.max(q.length, n.length, 1);
  if (n.includes(q) || q.includes(n)) score = Math.max(score, 0.72);
  return score;
}
function oldTopMatch(all, query) {
  let best = null, bestScore = 0.3;
  for (const c of all) {
    const s = oldSimilarity(query, c.name);
    if (s > bestScore) { bestScore = s; best = c.id; }
  }
  return best;
}

// ---------- Test ----------
const [en, de] = await Promise.all([loadDb("en"), loadDb("de")]);
const deById = new Map(de.map((c) => [c.id, c]));
const all = [...en, ...de];
let t0 = Date.now();
const index = Engine.buildIndex(en, de);
console.log(`Index: ${index.entries.length} Namen, ${index.bySetKey.size} Set-Schlüssel (${Date.now() - t0} ms)\n`);

const pool = en.filter((c) => !/token/i.test(c.type));
const samples = [];
for (let i = 0; i < SAMPLES; i++) {
  const card = pick(pool);
  const useDe = deById.has(card.id) && rand() < 0.6;
  samples.push({ card, name: useDe ? deById.get(card.id).name : card.name });
}

function report(label, results) {
  const n = results.length;
  const ok = results.filter((r) => r.ok).length;
  const sure = results.filter((r) => r.conf === "sure");
  const sureOk = sure.filter((r) => r.ok).length;
  const unsure = results.filter((r) => r.conf === "unsure");
  const line = [`${label.padEnd(34)} Top-1 richtig: ${((ok / n) * 100).toFixed(1).padStart(5)} %`];
  if (results[0].conf !== undefined) {
    line.push(`| sicher: ${((sure.length / n) * 100).toFixed(1)} % davon richtig ${sure.length ? ((sureOk / sure.length) * 100).toFixed(1) : "-"} %`);
    line.push(`| unsicher: ${((unsure.length / n) * 100).toFixed(1)} %`);
  }
  console.log(line.join(" "));
}

for (const level of ["light", "heavy"]) {
  const noisy = samples.map((s) => ({ ...s, ocr: ocrNoise(s.name, level) }));

  // alter Abgleich (langsam -> nur Teilmenge)
  const oldSubset = noisy.slice(0, Math.min(150, noisy.length));
  t0 = Date.now();
  const oldRes = oldSubset.map((s) => ({ ok: oldTopMatch(all, s.ocr) === s.card.id }));
  report(`ALT  Name (${level}, n=${oldSubset.length})`, oldRes);
  const oldMs = (Date.now() - t0) / oldSubset.length;

  t0 = Date.now();
  const newRes = noisy.map((s) => {
    const r = Engine.rankCandidates(index, { nameTexts: [s.ocr] });
    return { ok: r.candidates[0] && r.candidates[0].id === s.card.id, conf: r.confidence };
  });
  report(`NEU  Name (${level}, n=${noisy.length})`, newRes);
  const newMs = (Date.now() - t0) / noisy.length;

  const withCode = noisy.filter((s) => s.card.card_sets && s.card.card_sets.length);
  const codeRes = withCode.map((s) => {
    const set = pick(s.card.card_sets);
    const r = Engine.rankCandidates(index, { nameTexts: [s.ocr], codeTexts: [codeNoise(set.set_code)] });
    return { ok: r.candidates[0] && r.candidates[0].id === s.card.id, conf: r.confidence };
  });
  report(`NEU  Name + Set-Code (${level})`, codeRes);

  console.log(`     Zeit pro Abgleich: alt ${oldMs.toFixed(0)} ms, neu ${newMs.toFixed(0)} ms\n`);
}

// Reiner OCR-Müll darf praktisch nie als "sicher" gelten
{
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ   -=|~_.,0123";
  let sure = 0;
  const N = 400;
  for (let k = 0; k < N; k++) {
    let s = "";
    const len = 4 + Math.floor(rand() * 14);
    for (let i = 0; i < len; i++) s += chars[Math.floor(rand() * chars.length)];
    if (Engine.rankCandidates(index, { nameTexts: [s] }).confidence === "sure") sure++;
  }
  console.log(`Zufälliger OCR-Müll fälschlich "sicher": ${((sure / N) * 100).toFixed(1)} %\n`);
}

// Ein paar Beispiele zum Anschauen
for (const s of samples.slice(0, 6)) {
  const ocr = ocrNoise(s.name, "heavy");
  const r = Engine.rankCandidates(index, { nameTexts: [ocr] });
  const top = r.candidates[0];
  const topName = top ? (deById.get(top.id) || en.find((c) => c.id === top.id) || {}).name : "-";
  console.log(`"${ocr}"  ->  ${topName} (${top ? top.score.toFixed(2) : "-"}, ${r.confidence})  ${top && top.id === s.card.id ? "✓" : "✗ erwartet: " + s.name}`);
}
