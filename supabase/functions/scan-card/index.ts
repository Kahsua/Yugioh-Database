// ============================================================
// Supabase Edge Function "scan-card": Kartenfotos -> Google Gemini
// ============================================================
// Die App schickt 1-10 Fotos (JPEG, base64) in EINER Anfrage. Gemini liest
// je Foto Kartenname, Set-Code und Passcode und meldet, ob überhaupt eine
// Karte zu sehen ist. Mehrere Fotos auf einmal sparen Zeit und
// Gratis-Kontingent (das zählt Anfragen, nicht Bilder). Die Zuordnung zur
// Kartendatenbank macht danach die App (ScanEngine).
//
// Der Gemini-Schlüssel liegt NUR hier als Secret GEMINI_API_KEY (Supabase
// Dashboard -> Edge Functions -> Secrets), nie im Frontend. Nur angemeldete
// Nutzer der App dürfen die Funktion aufrufen.
//
// Deploy: npx supabase functions deploy scan-card --project-ref <ref> --use-api
// Optional: Secret GEMINI_MODEL (Standard: gemini-3.5-flash-lite)
//
// Anfrage:  { images: ["<base64>", ...] }
// Antwort:  { cards: [{ index, cardFound, name, language, setCode, passcode }], model }
// ============================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-scan-test-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_IMAGES = 10;

const PROMPT = `Du bekommst nummerierte Fotos. Auf jedem Foto kann eine Yu-Gi-Oh!-Sammelkarte liegen (oft in einer
Scan-Halterung, evtl. in einer Schutzhülle, evtl. mit Spiegelungen). Gib für JEDES Foto genau einen Eintrag
zurück, mit "index" = Nummer des Fotos. Antworte nur mit JSON nach dem Schema.
- cardFound: true nur, wenn eine Yu-Gi-Oh!-Karte deutlich mit ihrer Vorderseite zu sehen ist.
- name: der Kartenname genau so, wie er oben auf der Karte gedruckt ist (Sprache der Karte beibehalten,
  nicht übersetzen, Groß-/Kleinschreibung normal).
- language: Sprache der Karte als Kürzel (de, en, fr, it, es, pt, jp, kr) oder "" wenn unklar.
- setCode: der Set-Code unter dem Bild rechts, z.B. "PHRE-DE049", oder "" wenn nicht lesbar.
- passcode: die 8-stellige Zahl unten links, z.B. "45986603", oder "" wenn nicht lesbar.
Rate nicht: was du nicht sicher lesen kannst, bleibt leer. Verwechsle die Fotos nicht untereinander.`;

const SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      index: { type: "INTEGER" },
      cardFound: { type: "BOOLEAN" },
      name: { type: "STRING" },
      language: { type: "STRING" },
      setCode: { type: "STRING" },
      passcode: { type: "STRING" },
    },
    required: ["index", "cardFound", "name", "language", "setCode", "passcode"],
  },
};

// Denk-Einstellung des Modells (null = Standard des Modells)
const THINKING: Record<string, unknown> | null = null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);

  // Nur angemeldete Nutzer (schützt das Gratis-Kontingent vor Fremden).
  // Ausnahme für Entwicklungstests: Header x-scan-test-token = Secret
  // SCAN_TEST_TOKEN (nur gesetzt, solange getestet wird).
  const testToken = Deno.env.get("SCAN_TEST_TOKEN");
  const isTest = !!testToken && req.headers.get("x-scan-test-token") === testToken;
  if (!isTest) {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) return json({ error: "Nicht angemeldet" }, 401);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return json({ error: "GEMINI_API_KEY fehlt (Supabase Secrets)" }, 500);
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-3.5-flash-lite"; // im Test: 7/7 Namen

  let body: { images?: unknown; image?: unknown; action?: string; model?: string; thinking?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Ungültige Anfrage" }, 400);
  }

  // Nur für Entwicklungstests: verfügbare Modelle auflisten
  if (isTest && body.action === "models") {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
      headers: { "x-goog-api-key": apiKey },
    });
    const list = await r.json();
    return json(
      (list.models || [])
        .filter((m: { supportedGenerationMethods?: string[] }) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m: { name: string }) => m.name)
    );
  }

  const images = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];
  if (images.length === 0 || images.length > MAX_IMAGES) return json({ error: `1-${MAX_IMAGES} Bilder erwartet` }, 400);
  let totalSize = 0;
  for (const img of images) {
    if (typeof img !== "string" || img.length < 100) return json({ error: "Ungültiges Bild" }, 400);
    totalSize += img.length;
  }
  if (totalSize > 15_000_000) return json({ error: "Bilder zu groß" }, 400);

  // Entwicklungstests dürfen Modell und Denk-Einstellung vorgeben
  const useModel = isTest && body.model ? body.model : model;
  const thinkingConfig = isTest && body.thinking ? body.thinking : THINKING;

  const parts: unknown[] = [{ text: PROMPT }];
  images.forEach((img, i) => {
    parts.push({ text: `Foto ${i + 1}:` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data: (img as string).replace(/^data:image\/\w+;base64,/, "") } });
  });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${useModel}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        temperature: 0,
        ...(thinkingConfig ? { thinkingConfig } : {}),
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    // 429 = Gratis-Kontingent (pro Minute/Tag) erschöpft, 503 = Modell überlastet
    const error = res.status === 429 ? "Gemini-Limit erreicht" : res.status === 503 ? "Gemini überlastet" : "Gemini-Fehler";
    return json({ error, status: res.status, detail: detail.slice(0, 500) }, 502);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  try {
    const cards = JSON.parse(text);
    return json({ cards: Array.isArray(cards) ? cards : [cards], model: useModel });
  } catch {
    return json({ error: "Antwort von Gemini nicht lesbar", detail: text.slice(0, 300) }, 502);
  }
});
