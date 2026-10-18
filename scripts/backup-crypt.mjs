// ============================================================
// Ver-/Entschlüsselung des Backup-Ordners (AES-256-GCM, Schlüssel per scrypt)
// ============================================================
// Verschlüsseln:  node scripts/backup-crypt.mjs encrypt backup backup.enc
// Entschlüsseln:  node scripts/backup-crypt.mjs decrypt backup.enc wiederhergestellt
//
// Passwort kommt aus der Umgebungsvariable BACKUP_PASSWORD oder, falls nicht
// gesetzt, aus der lokalen Datei backup-passwort.txt (nicht im Repo).
// Nötig, weil Workflow-Downloads in öffentlichen Repos für jeden
// angemeldeten GitHub-Nutzer abrufbar sind.
// ============================================================

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAGIC = Buffer.from("YGOBAK1");

function loadPassword() {
  if (process.env.BACKUP_PASSWORD) return process.env.BACKUP_PASSWORD;
  const file = join(ROOT, "backup-passwort.txt");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  throw new Error("Kein Passwort: BACKUP_PASSWORD setzen oder backup-passwort.txt anlegen.");
}

function deriveKey(password, salt) {
  return scryptSync(password, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encrypt(srcDir, outFile) {
  const files = {};
  for (const name of readdirSync(srcDir)) files[name] = readFileSync(join(srcDir, name), "utf8");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(loadPassword(), salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(files)), cipher.final()]);
  writeFileSync(outFile, Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), data]));
  console.log(`${Object.keys(files).length} Dateien verschlüsselt -> ${outFile}`);
}

function decrypt(inFile, outDir) {
  const buf = readFileSync(inFile);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Keine Backup-Datei.");
  let pos = MAGIC.length;
  const salt = buf.subarray(pos, (pos += 16));
  const iv = buf.subarray(pos, (pos += 12));
  const tag = buf.subarray(pos, (pos += 16));
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(loadPassword(), salt), iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(buf.subarray(pos)), decipher.final()]);
  } catch {
    throw new Error("Entschlüsseln fehlgeschlagen – falsches Passwort oder beschädigte Datei.");
  }
  const files = JSON.parse(plain.toString("utf8"));
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(outDir, name), content);
  console.log(`${Object.keys(files).length} Dateien entschlüsselt -> ${outDir}`);
}

const [mode, from, to] = process.argv.slice(2);
if (mode === "encrypt" && from && to) encrypt(from, to);
else if (mode === "decrypt" && from && to) decrypt(from, to);
else {
  console.error("Aufruf: node scripts/backup-crypt.mjs encrypt|decrypt <von> <nach>");
  process.exit(1);
}
