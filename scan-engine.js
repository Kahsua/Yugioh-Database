// ============================================================
// SCAN-ENGINE: Kartenzuordnung aus OCR-Text (ohne DOM, auch in Node testbar)
// ============================================================
// Bekommt den erkannten Text aus mehreren Bildausschnitten einer Karte
// (Name, Set-Code-Zeile, Passcode-Zeile) und ermittelt daraus die
// wahrscheinlichsten Karten aus der YGOPRODeck-Datenbank - inkl. einer
// Sicherheitsstufe ("sure" / "unsure" / "none").
//
// Drei unabhängige Hinweise werden kombiniert:
//   1. Kartenname   – tippfehlertoleranter Abgleich gegen alle DE/EN-Namen
//   2. Set-Code     – z.B. "LEDE-DE012" unter dem Artwork (pro Druck eindeutig)
//   3. Passcode     – 8-stellige Zahl unten links (= YGOPRODeck-ID)
//
// Im Browser als window.ScanEngine verfügbar, in Node per require().
// ============================================================
(function (root) {
  "use strict";

  // ---------- Normalisierung ----------
  // Kleinbuchstaben, ohne Akzente/Umlaut-Punkte, ß -> ss, NUR a-z0-9.
  // Leerzeichen fallen bewusst weg: OCR trennt/verschmilzt Wörter oft falsch.
  function normalizeName(s) {
    return (s || "")
      .toString()
      .toLowerCase()
      .replace(/ß/g, "ss")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "");
  }

  // ---------- Gewichtete Editierdistanz ----------
  // Typische OCR-Verwechslungen kosten weniger als eine echte Abweichung.
  const CONFUSABLE_PAIRS = [
    ["o", "0"], ["l", "1"], ["i", "1"], ["i", "l"], ["s", "5"], ["b", "8"], ["z", "2"],
    ["g", "9"], ["u", "v"], ["c", "e"], ["a", "o"], ["n", "h"], ["t", "f"], ["e", "o"],
  ];
  const confusable = new Uint8Array(128 * 128);
  for (const [a, b] of CONFUSABLE_PAIRS) {
    confusable[a.charCodeAt(0) * 128 + b.charCodeAt(0)] = 1;
    confusable[b.charCodeAt(0) * 128 + a.charCodeAt(0)] = 1;
  }
  const SUB_CONFUSABLE = 0.4;
  // Überzählige OCR-Zeichen am Anfang/Ende (Rand-Rauschen, Teile des
  // Attribut-Symbols ...) kosten weniger als echte Fehler im Namen.
  const SKIP = 0.35;

  let rowA = new Float32Array(128);
  let rowB = new Float32Array(128);

  // Fehlt das Ende des Namens im OCR-Text (Name abgeschnitten, lange Namen
  // in sehr kleiner Schrift), kostet jedes fehlende Zeichen weniger als ein Fehler.
  const NAME_TAIL = 0.55;

  // Semi-globale Ausrichtung: der Kartenname muss passen (Ende darf günstig
  // fehlen), vom OCR-Text dürfen vorne/hinten Zeichen günstig übersprungen werden.
  function alignDistance(name, ocr) {
    const n = name.length;
    const m = ocr.length;
    if (rowA.length < m + 1) {
      rowA = new Float32Array(m + 1);
      rowB = new Float32Array(m + 1);
    }
    let prev = rowA;
    let cur = rowB;
    for (let j = 0; j <= m; j++) prev[j] = j * SKIP;
    let truncated = n * NAME_TAIL + m * SKIP;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      const a = name.charCodeAt(i - 1);
      for (let j = 1; j <= m; j++) {
        const b = ocr.charCodeAt(j - 1);
        let v = prev[j - 1] + (a === b ? 0 : a < 128 && b < 128 && confusable[a * 128 + b] ? SUB_CONFUSABLE : 1);
        const del = prev[j] + 1;
        if (del < v) v = del;
        const ins = cur[j - 1] + 1;
        if (ins < v) v = ins;
        cur[j] = v;
      }
      if (i < n) {
        // Variante "Name nach i Zeichen abgeschnitten"
        const tail = (n - i) * NAME_TAIL;
        for (let j = 0; j <= m; j++) {
          const v = cur[j] + (m - j) * SKIP + tail;
          if (v < truncated) truncated = v;
        }
      }
      const t = prev;
      prev = cur;
      cur = t;
    }
    let best = truncated;
    for (let j = 0; j <= m; j++) {
      const v = prev[j] + (m - j) * SKIP;
      if (v < best) best = v;
    }
    return best;
  }

  // Ähnlichkeit 0..1 zwischen normalisiertem Kartennamen und OCR-Text.
  // Kurze Namen, die nur einen kleinen Teil des OCR-Texts abdecken, werden
  // zusätzlich abgewertet (sonst passt z.B. "Ra" in fast jeden Text).
  function similarity(nameNorm, ocrNorm) {
    const n = nameNorm.length;
    const m = ocrNorm.length;
    if (!n || !m) return 0;
    const d = alignDistance(nameNorm, ocrNorm);
    let score = 1 - d / Math.max(n, m);
    if (n < m * 0.6) score *= n / (m * 0.6);
    return Math.max(0, score);
  }

  // Obergrenze der Ähnlichkeit allein aus den Längen - spart die teure
  // Berechnung für Namen, die ohnehin nicht passen können.
  function similarityUpperBound(n, m) {
    const lb = n > m ? (n - m) * NAME_TAIL : (m - n) * SKIP;
    let score = 1 - lb / Math.max(n, m);
    if (n < m * 0.6) score *= n / (m * 0.6);
    return score;
  }

  // ---------- Set-Codes & Passcodes ----------
  // "LEDE-EN012" / "LEDE-DE012" / "SDY-G001" / "SDY-001" -> "LEDE-012" bzw. "SDY-001":
  // Präfix + letzte 3 Zeichen, die Sprach-/Regionskennung fällt weg.
  function setKeyFromCode(code) {
    const m = /^([A-Z0-9]+)-([A-Z0-9]+)$/.exec((code || "").toUpperCase().trim());
    if (!m || m[2].length < 3) return null;
    return m[1] + "-" + m[2].slice(-3);
  }

  const DIGIT_FIX = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };

  // Alle plausiblen Set-Schlüssel aus einem OCR-Text. Liefert bewusst mehrere
  // Varianten (Präfixlänge, O/0-Verwechslungen) - welche davon real
  // existiert, entscheidet der Abgleich mit dem Index.
  function extractSetKeys(text) {
    const keys = new Set();
    const t = (text || "").toUpperCase().replace(/[‐-―_~]/g, "-").replace(/\s*-\s*/g, "-");
    const re = /([A-Z0-9]{2,6})-([A-Z0-9]{3,5})/g;
    let m;
    while ((m = re.exec(t))) {
      const rawPrefix = m[1];
      const suffix = m[2].slice(-3);
      const fixedSuffix = suffix.replace(/[A-Z]/g, (c) => DIGIT_FIX[c] || c);
      for (let len = 2; len <= Math.min(5, rawPrefix.length); len++) {
        const prefix = rawPrefix.slice(-len);
        const prefixVariants = new Set([prefix, prefix.replace(/O/g, "0"), prefix.replace(/0/g, "O")]);
        for (const p of prefixVariants) {
          keys.add(p + "-" + suffix);
          keys.add(p + "-" + fixedSuffix);
        }
      }
    }
    return [...keys];
  }

  // 8-stellige Passcodes (unten links auf der Karte, = Karten-ID).
  function extractPasscodes(text) {
    const t = (text || "").toUpperCase().replace(/[OQD]/g, "0").replace(/[IL]/g, "1");
    const out = [];
    const re = /(^|\D)(\d{8})(?!\d)/g;
    let m;
    while ((m = re.exec(t))) out.push(parseInt(m[2], 10));
    return out;
  }

  // ---------- Index ----------
  // cardsEn / cardsDe: Arrays aus der YGOPRODeck-API (cardinfo.php).
  function buildIndex(cardsEn, cardsDe) {
    const entries = []; // { id, norm }
    const namesById = new Map(); // id -> [norm, ...]
    const passToId = new Map(); // Passcode (auch alternative Artworks) -> Haupt-ID
    const bySetKey = new Map(); // "LEDE-012" -> Set(ids)

    const addName = (id, name) => {
      const norm = normalizeName(name);
      if (norm.length < 2) return;
      const list = namesById.get(id) || [];
      if (list.includes(norm)) return;
      list.push(norm);
      namesById.set(id, list);
      entries.push({ id, norm });
    };

    for (const list of [cardsEn || [], cardsDe || []]) {
      for (const card of list) {
        addName(card.id, card.name);
        passToId.set(card.id, card.id);
        for (const img of card.card_images || []) if (!passToId.has(img.id)) passToId.set(img.id, card.id);
        for (const set of card.card_sets || []) {
          const key = setKeyFromCode(set.set_code);
          if (!key) continue;
          if (!bySetKey.has(key)) bySetKey.set(key, new Set());
          bySetKey.get(key).add(card.id);
        }
      }
    }
    return { entries, namesById, passToId, bySetKey };
  }

  // ---------- Namensabgleich ----------
  // Teilt den OCR-Text in sinnvolle Abfragen (einzelne Zeilen + alles zusammen).
  function nameQueries(text) {
    const lines = (text || "")
      .split(/\n+/)
      .map(normalizeName)
      .filter((l) => l.length >= 3);
    const queries = new Set(lines.sort((a, b) => b.length - a.length).slice(0, 3));
    const joined = normalizeName(text);
    if (joined.length >= 3 && joined.length <= 80) queries.add(joined);
    return [...queries];
  }

  const MIN_NAME_SCORE = 0.35;

  // Beste Namens-Treffer für einen OCR-Text: [{ id, score }] absteigend.
  function matchName(index, text, limit = 8) {
    const best = new Map();
    for (const q of nameQueries(text)) {
      const m = q.length;
      for (const e of index.entries) {
        if (similarityUpperBound(e.norm.length, m) < MIN_NAME_SCORE) continue;
        const s = similarity(e.norm, q);
        if (s >= MIN_NAME_SCORE && s > (best.get(e.id) || 0)) best.set(e.id, s);
      }
    }
    return [...best.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Namensähnlichkeit einer bestimmten Karte zu einem OCR-Text.
  function nameScoreFor(index, id, text) {
    const names = index.namesById.get(id) || [];
    let best = 0;
    for (const q of nameQueries(text)) for (const n of names) best = Math.max(best, similarity(n, q));
    return best;
  }

  // ---------- Kombination aller Hinweise ----------
  const SET_BONUS = 0.3;
  const PASS_BONUS = 0.4;
  // Schwellen per scripts/test-matcher.mjs mit simulierten OCR-Fehlern
  // abgestimmt (0 Fehlzuordnungen bei "sicher"); mit echten Fotos nachjustieren.
  const SURE_SCORE = 0.75;
  const SURE_MARGIN = 0.08;
  const SHORT_NAME_SURE_SCORE = 0.92;
  const UNSURE_SCORE = 0.5;

  function rankCandidates(index, { nameTexts = [], codeTexts = [] } = {}) {
    const cand = new Map(); // id -> { id, name, set, pass }
    const get = (id) => {
      if (!cand.has(id)) cand.set(id, { id, name: 0, set: false, pass: false });
      return cand.get(id);
    };

    for (const t of nameTexts) {
      for (const { id, score } of matchName(index, t, 10)) {
        const c = get(id);
        if (score > c.name) c.name = score;
      }
    }

    for (const t of codeTexts) {
      for (const key of extractSetKeys(t)) {
        const ids = index.bySetKey.get(key);
        if (ids && ids.size <= 3) ids.forEach((id) => (get(id).set = true));
      }
      for (const code of extractPasscodes(t)) {
        const id = index.passToId.get(code);
        if (id !== undefined) get(id).pass = true;
      }
    }

    // Kandidaten, die nur über einen Code gefunden wurden, brauchen noch ihren Namenswert
    for (const c of cand.values()) {
      if (c.name === 0 && (c.set || c.pass)) {
        for (const t of nameTexts) c.name = Math.max(c.name, nameScoreFor(index, c.id, t));
      }
    }

    const ranked = [...cand.values()]
      .map((c) => ({ ...c, score: c.name + (c.set ? SET_BONUS : 0) + (c.pass ? PASS_BONUS : 0) }))
      .sort((a, b) => b.score - a.score);

    let confidence = "none";
    const top = ranked[0];
    if (top) {
      // Karten, deren Name komplett im Namen der Top-Karte steckt ("Code Talker"
      // in "Decode Talker"), passen zwangsläufig auch gut - sie sprechen nicht
      // gegen die Top-Karte, wenn deren Name selbst sehr gut passt.
      const topNames = index.namesById.get(top.id) || [];
      const rival = ranked.slice(1).find(
        (c) =>
          !(top.name >= 0.85 &&
            (index.namesById.get(c.id) || []).some((n) => topNames.some((t) => t !== n && t.includes(n))))
      );
      const margin = top.score - (rival ? rival.score : 0);
      // Sehr kurze Namen ("Eva", "Ameba") passen zufällig auch auf OCR-Müll -
      // ohne Code-Bestätigung nur bei nahezu perfektem Treffer "sicher".
      const shortName = Math.max(0, ...topNames.map((t) => t.length)) <= 6;
      const sureScore = shortName && !top.set && !top.pass ? SHORT_NAME_SURE_SCORE : SURE_SCORE;
      if ((top.score >= sureScore && margin >= SURE_MARGIN) || (top.set && top.pass)) confidence = "sure";
      else if (top.score >= UNSURE_SCORE) confidence = "unsure";
    }
    return { candidates: ranked, confidence };
  }

  // ---------- Bildvorverarbeitung (auf RGBA-Pixeldaten) ----------
  function toGray(data, n) {
    const gray = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; p < n; i += 4, p++) gray[p] = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0;
    return gray;
  }

  function otsuThreshold(gray) {
    const hist = new Array(256).fill(0);
    for (let p = 0; p < gray.length; p++) hist[gray[p]]++;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = gray.length - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const diff = sumB / wB - (sum - sumB) / wF;
      const v = wB * wF * diff * diff;
      if (v > maxVar) {
        maxVar = v;
        threshold = t;
      }
    }
    return threshold;
  }

  // mode "gray":     Graustufen + Kontrastspreizung (Tesseract binarisiert selbst)
  // mode "adaptive": lokale Schwelle (Bradley) - robust gegen Farbverläufe,
  //                  Foil-Glanz und ungleichmäßiges Licht
  // In beiden Fällen wird auf dunkle Schrift / hellen Grund normalisiert
  // (Xyz-, Zauber- und Fallen-Namen sind hell auf dunkel gedruckt).
  // Schreibt in-place in `data` (RGBA).
  function preprocessPixels(data, width, height, mode) {
    const n = width * height;
    const gray = toGray(data, n);
    const thr = otsuThreshold(gray);
    let dark = 0;
    for (let p = 0; p < n; p++) if (gray[p] < thr) dark++;
    const invert = dark > n / 2;
    if (invert) for (let p = 0; p < n; p++) gray[p] = 255 - gray[p];

    let out;
    if (mode === "adaptive") {
      const integral = new Float64Array((width + 1) * (height + 1));
      for (let y = 0; y < height; y++) {
        let rowSum = 0;
        for (let x = 0; x < width; x++) {
          rowSum += gray[y * width + x];
          integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + rowSum;
        }
      }
      const r = Math.max(4, Math.round(height / 2));
      const T = 0.15;
      out = new Uint8ClampedArray(n);
      for (let y = 0; y < height; y++) {
        const y0 = Math.max(0, y - r), y1 = Math.min(height, y + r + 1);
        for (let x = 0; x < width; x++) {
          const x0 = Math.max(0, x - r), x1 = Math.min(width, x + r + 1);
          const area = (x1 - x0) * (y1 - y0);
          const s =
            integral[y1 * (width + 1) + x1] - integral[y0 * (width + 1) + x1] -
            integral[y1 * (width + 1) + x0] + integral[y0 * (width + 1) + x0];
          out[y * width + x] = gray[y * width + x] * area < s * (1 - T) ? 0 : 255;
        }
      }
    } else {
      const hist = new Array(256).fill(0);
      for (let p = 0; p < n; p++) hist[gray[p]]++;
      let lo = 0, hi = 255, acc = 0;
      for (; lo < 255; lo++) if ((acc += hist[lo]) > n * 0.02) break;
      acc = 0;
      for (; hi > 0; hi--) if ((acc += hist[hi]) > n * 0.02) break;
      const range = Math.max(1, hi - lo);
      out = new Uint8ClampedArray(n);
      for (let p = 0; p < n; p++) out[p] = ((gray[p] - lo) * 255) / range;
    }

    removeFrameLines(out, width, height);

    for (let i = 0, p = 0; p < n; i += 4, p++) {
      data[i] = data[i + 1] = data[i + 2] = out[p];
      data[i + 3] = 255;
    }
  }

  // Rahmenlinien des Namensfelds / Kartenrands (fast komplett dunkle Zeilen
  // oder Spalten) weiß machen - Tesseract liest sonst oft gar nichts, obwohl
  // der Name selbst gut lesbar wäre. Zusätzlich wird alles vom Bildrand bis zu
  // so einer Linie entfernt (liegt außerhalb des Namensfelds).
  // "Dunkel" heißt dabei: deutlich dunkler als eine typische Zeile/Spalte -
  // nicht absolut, weil farbige Namensfelder in Graustufen mittelgrau sind.
  function removeFrameLines(px, width, height) {
    const rowMean = new Float32Array(height);
    const colMean = new Float32Array(width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = px[y * width + x];
        rowMean[y] += v;
        colMean[x] += v;
      }
    }
    for (let y = 0; y < height; y++) rowMean[y] /= width;
    for (let x = 0; x < width; x++) colMean[x] /= height;
    const median = (arr) => Float32Array.from(arr).sort()[arr.length >> 1];
    const rowLimit = median(rowMean) * 0.55;
    const colLimit = median(colMean) * 0.5;
    const isDarkRow = (y) => rowMean[y] < rowLimit;
    const isDarkCol = (x) => colMean[x] < colLimit;
    const clearRows = (y0, y1) => px.fill(255, y0 * width, y1 * width);
    const clearCol = (x) => {
      for (let y = 0; y < height; y++) px[y * width + x] = 255;
    };

    const third = Math.floor(height / 3);
    let top = -1;
    let bottom = height;
    for (let y = 0; y < third; y++) if (isDarkRow(y)) top = y;
    for (let y = height - 1; y >= height - third; y--) if (isDarkRow(y)) bottom = y;
    if (top >= 0) clearRows(0, top + 1);
    if (bottom < height) clearRows(bottom, height);
    for (let y = top + 1; y < bottom; y++) if (isDarkRow(y)) clearRows(y, y + 1);

    const edge = Math.floor(width * 0.08);
    let left = -1;
    let right = width;
    for (let x = 0; x < edge; x++) if (isDarkCol(x)) left = x;
    for (let x = width - 1; x >= width - edge; x--) if (isDarkCol(x)) right = x;
    for (let x = 0; x <= left; x++) clearCol(x);
    for (let x = right; x < width; x++) clearCol(x);
  }

  // Sucht in einem Bildstreifen die Zeile mit der stärksten Schrift: Schrift
  // hat viele horizontale Hell-Dunkel-Wechsel, waagerechte Rahmenlinien fast
  // keine. Liefert [y0, y1] als Anteile der Höhe oder null.
  // from/to begrenzen den Suchbereich (Anteile der Höhe).
  function locateTextBand(data, width, height, from = 0, to = 1) {
    const gray = toGray(data, width * height);
    const energy = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      let e = 0;
      for (let x = y * width, end = x + width - 1; x < end; x++) e += Math.abs(gray[x + 1] - gray[x]);
      energy[y] = e / width;
    }
    const k = Math.max(1, Math.round(height * 0.03));
    const smooth = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      let s = 0, c = 0;
      for (let d = -k; d <= k; d++) {
        if (y + d >= 0 && y + d < height) {
          s += energy[y + d];
          c++;
        }
      }
      smooth[y] = s / c;
    }
    let peakY = -1;
    let peak = 0;
    for (let y = Math.floor(from * height); y < Math.min(height, Math.ceil(to * height)); y++) {
      if (smooth[y] > peak) {
        peak = smooth[y];
        peakY = y;
      }
    }
    if (peakY < 0 || peak < 4) return null; // kaum Struktur - keine Schrift gefunden
    let y0 = peakY;
    let y1 = peakY;
    while (y0 > 0 && smooth[y0 - 1] > peak * 0.4) y0--;
    while (y1 < height - 1 && smooth[y1 + 1] > peak * 0.4) y1++;
    return [y0 / height, (y1 + 1) / height];
  }

  const api = {
    locateTextBand,
    normalizeName,
    similarity,
    setKeyFromCode,
    extractSetKeys,
    extractPasscodes,
    buildIndex,
    matchName,
    nameScoreFor,
    rankCandidates,
    preprocessPixels,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScanEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
