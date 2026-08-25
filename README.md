# Kartenarchiv – eure Yu-Gi-Oh-Sammlung

Eine kleine Web-App für dich und deine Freunde: Karte suchen (deutsch oder
englisch), Bild + Werte werden automatisch von der [YGOPRODeck](https://ygoprodeck.com)-Datenbank
geladen, Anzahl eintragen, speichern. Jeder hat seine eigene Sammlung, aber
alle können sehen, wer welche Karten hat.

Kein Server, kein Build-Prozess – nur statische Dateien (HTML/CSS/JS), die
Daten liegen kostenlos bei [Supabase](https://supabase.com).

---

## 1. Supabase-Projekt einrichten (5 Minuten, kostenlos)

1. Gehe auf [supabase.com](https://supabase.com) → **Start your project** → mit GitHub/Google anmelden.
2. **New Project** erstellen (Name frei wählbar, z. B. `kartenarchiv`), Region z. B. Frankfurt (`eu-central-1`), Datenbank-Passwort notieren.
3. Warte, bis das Projekt fertig aufgesetzt ist (~2 Min.).
4. Im Menü links: **SQL Editor** → **New query**.
5. Öffne die Datei `supabase-schema.sql` aus diesem Projekt, kopiere den kompletten Inhalt hinein und klicke **Run**. Das legt die Tabellen `profiles` und `cards` inkl. Zugriffsrechten an.
6. Im Menü links: **Authentication** → **Providers** → stelle sicher, dass **Email** aktiviert ist.
   - Für den privaten Gebrauch mit Freunden empfehlen wir, unter **Authentication → Settings** die Option **„Confirm email"** zu deaktivieren, damit man sich sofort ohne Mail-Bestätigung anmelden kann. (Optional – kannst du auch anlassen.)
7. Im Menü links: **Project Settings → API**. Dort findest du:
   - **Project URL**
   - **anon public** Key

## 2. App konfigurieren

Öffne `config.js` in diesem Projekt und trage die beiden Werte aus Schritt 1.7 ein:

```js
window.YGO_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
};
```

Das sind öffentliche Werte (kein Geheimnis) – die eigentliche Absicherung
übernehmen die Row-Level-Security-Regeln aus dem SQL-Skript: Jeder kann alle
Karten *sehen*, aber nur seine **eigenen** Karten anlegen, ändern oder löschen.

## 3. Lokal testen (optional, aber empfohlen)

Da die Seite `fetch`-Aufrufe macht, funktioniert sie nicht zuverlässig direkt
per Doppelklick auf `index.html`. Starte stattdessen einen kleinen lokalen
Server im Projektordner:

```bash
# Python (meist vorinstalliert)
python3 -m http.server 8000

# oder mit Node.js
npx serve .
```

Dann im Browser `http://localhost:8000` öffnen.

## 4. Online hosten

### Option A: Vercel (empfohlen, sehr einfach)

1. Lade dieses Projekt als GitHub-Repository hoch (oder nutze `vercel` CLI direkt).
2. Auf [vercel.com](https://vercel.com) → **Add New Project** → Repository auswählen.
3. Es ist kein Framework, also bei „Build Command" **nichts** eintragen und als **Output Directory** `.` lassen (Vercel erkennt statische Projekte automatisch).
4. **Deploy** klicken → fertig, du bekommst eine `https://...vercel.app`-URL.

### Option B: GitHub Pages (kostenlos, direkt bei GitHub)

1. Erstelle ein neues GitHub-Repository und lade **alle Dateien und Ordner** dieses Projekts hoch, inklusive des `icons/`-Ordners (`index.html`, `style.css`, `app.js`, `config.js`, `manifest.json`, `service-worker.js`, `icons/`).
2. Im Repository: **Settings → Pages**.
3. Bei **Source** wähle **Deploy from a branch**, Branch `main`, Ordner `/ (root)`.
4. Speichern – nach 1–2 Minuten ist die Seite unter `https://DEIN-NAME.github.io/DEIN-REPO/` erreichbar.

**Wichtig:** `config.js` mit deinen Supabase-Zugangsdaten wird mit hochgeladen
und ist damit öffentlich einsehbar. Das ist bei Supabase so vorgesehen (der
`anon`-Key ist für den Frontend-Einsatz gedacht) – die eigentliche Sicherheit
kommt aus den RLS-Regeln. Lade nur **niemals** ein `service_role`-Secret hoch.

## 5. Nutzung

1. Jede Person aus eurer Gruppe registriert sich einmal mit E-Mail, Passwort und einem Anzeigenamen.
2. **„Suchen"**: Namen eingeben (DE/EN umschaltbar), Karte anklicken, Anzahl eintragen, speichern.
3. **„Scannen"**: Karte per Handykamera fotografieren, Name wird automatisch erkannt und gesucht (siehe unten).
4. **„Meine Sammlung"**: eigene Karten durchsuchen/filtern, Anzahl per +/− anpassen oder löschen, Klick auf eine Karte zeigt alle Details.
5. **„Alle Sammlungen"**: alle Karten aller Mitglieder durchsuchen und nach Besitzer/Kategorie/Typ/Attribut filtern.
6. **„Verlauf"**: zeigt die letzten Änderungen (hinzugefügt/geändert/gelöscht/importiert) – praktisch, um versehentliche Änderungen nachzuvollziehen.
7. **„Import"**: bestehende Sammlung aus Excel/CSV auf einen Schlag übernehmen.

## 6. Kartenscan per Kamera

Im Tab **„📷 Scannen"** gibt es zwei Modi:

### Einzelbild
1. **„Kamera starten"**, Berechtigung erlauben (nur beim ersten Mal nötig).
2. Karte so halten, dass der **Name oben gut lesbar** ist – gerade, gut beleuchtet, ohne Spiegelungen.
3. **„Foto aufnehmen"**.
4. Erkannter Name erscheint editierbar, Suchergebnisse darunter – Karte anklicken, Anzahl eintragen, speichern.

### Auto-Scan (Serie) – für den Ständer/Kartenschacht-Aufbau
Gedacht genau für dein Szenario: Handy fest positioniert, Karten nacheinander in den Kamerabereich fallen lassen.

1. Modus **„Auto-Scan (Serie)"** wählen, **„Auto-Scan starten"**.
2. Die App beobachtet das Kamerabild auf Bewegung. Sobald eine Karte kurz **ruhig liegt** (ca. 1 Sekunde), wird sie automatisch fotografiert, erkannt und einer Miniatur-Warteschlange hinzugefügt. Danach wartet die App auf die nächste Bewegung (die nächste Karte fällt rein / die alte wird entfernt), bevor sie erneut auslöst – so wird dieselbe Karte nicht mehrfach erfasst.
3. Scannst du dieselbe Karte mehrmals hintereinander, erhöht die App automatisch die Anzahl statt eine neue Zeile anzulegen.
4. **„Scan-Lauf beenden"**, sobald du fertig bist.
5. Es öffnet sich eine **Übersicht aller erfassten Karten**: Bild, erkannter Name (editierbar), Anzahl, und ein 🔍-Button zum erneuten Suchen, falls die automatische Zuordnung falsch war. Mit 🗑 lassen sich Fehlscans entfernen.
6. **„Alle bestätigen & speichern"** überträgt alles gesammelt in deine Sammlung.

**Praxistipps für den Auto-Scan:**
- Gleichmäßiges, helles Licht ohne harte Schatten hilft sowohl der Bewegungserkennung als auch der Texterkennung.
- Ein einfarbiger, kontrastreicher Hintergrund (z. B. dunkle Matte) verbessert die Bewegungs-Erkennung deutlich.
- Die Bewegungserkennung reagiert auf **Helligkeitsänderungen im Bild** – funktioniert am zuverlässigsten, wenn nur die Karten selbst sich bewegen (Kamera und Hintergrund bleiben fest).
- Falls die automatische Erkennung mal daneben liegt: kein Problem, das wird ja erst am Ende in der Übersicht bestätigt, bevor irgendwas gespeichert wird.

**Allgemeiner Hinweis:** Die Texterkennung läuft komplett lokal im Browser (keine Kartenbilder werden hochgeladen) und braucht eine sichere Verbindung (`https://...`, wie bei GitHub Pages üblich) – lokal per Doppelklick auf `index.html` funktioniert das nicht.

## 7. Als App installieren

Die Seite ist eine **Progressive Web App (PWA)** und lässt sich wie eine echte App installieren – auf dem Smartphone und auch auf dem Desktop:

**Am PC (Chrome/Edge):** Seite öffnen → rechts in der Adressleiste erscheint ein Installations-Symbol (⊕ bzw. Bildschirm-Symbol) → klicken → „Installieren". Danach startet die App wie ein eigenständiges Programm, ganz ohne Browser-Drumherum.

**Am Smartphone (Chrome/Android):** Seite öffnen → Menü (⋮) → **„App installieren"** bzw. **„Zum Startbildschirm hinzufügen"**.

**Am iPhone (Safari):** Seite öffnen → Teilen-Symbol → **„Zum Home-Bildschirm"**.

Die App bekommt dann ein eigenes Icon und startet ohne Adressleiste/Browser-UI, exakt wie eine „richtige" App.

## Bestehende Sammlung importieren

Deine bisherige Excel-Datenbank wurde bereits in ein passendes CSV umgewandelt:
**`Yugioh_Sammlung_Import.csv`** (2.330 Karten, 4.852 Exemplare) liegt in diesem Projektordner.

So importierst du sie:

1. Melde dich in der App mit deinem eigenen Account an.
2. Gehe zum Tab **„Import"**.
3. Wähle `Yugioh_Sammlung_Import.csv` aus.
4. Klicke **„Import starten"**.

Was dabei passiert:
- Die App lädt einmalig die **komplette YGOPRODeck-Datenbank** (Deutsch + Englisch, ca. 13.000 Karten) in den Browser.
- Jede deiner Karten wird per Name automatisch zugeordnet – dabei wird die offizielle Karten-ID und das Kartenbild ergänzt.
- Deine bereits eingetragenen Werte (Kartenart, Attribut, ATK/DEF, Anzahl usw.) bleiben erhalten.
- Karten, die keinen automatischen Treffer finden (z. B. abweichende Schreibweise, alternative Kunst, sehr neue Karten), werden trotzdem mit deinen Excel-Werten gespeichert – nur ohne Bild. Sie werden am Ende als Liste angezeigt, damit du sie bei Bedarf manuell nachträgst.
- Der Import prüft automatisch, ob eine Karte bereits in deiner Sammlung existiert, und überspringt Duplikate – du kannst die Datei also gefahrlos ein zweites Mal hochladen, ohne alles doppelt zu bekommen.
- Dauer: bei ~2.300 Karten ca. 30–60 Sekunden, hauptsächlich für den Datenbank-Download.

**Eigene CSV verwenden:** Falls du später weitere Karten per CSV importieren willst, achte auf exakt diese Spaltenüberschriften (Reihenfolge egal):
```
Deutsch,Englisch,Kartenart,Kartentyp,Eigenschaft,Typ,Stufe_Rang_Link,ATK,DEF,Anzahl
```
Nur `Deutsch` (oder `Englisch`) und `Anzahl` sind zwingend nötig, der Rest ist optional.

## Technische Details

- Kartendaten kommen live von der kostenlosen [YGOPRODeck API](https://db.ygoprodeck.com/api-guide/) – keine eigene Kartendatenbank nötig, immer aktuell inkl. neuer Sets.
- Die Suche fragt Deutsch und Englisch parallel ab, damit sowohl der deutsche als auch der englische Name gespeichert werden, unabhängig davon in welcher Sprache gesucht wurde.
- Datenspeicherung in Supabase (Postgres), Zugriff direkt aus dem Browser über die `supabase-js`-Bibliothek, keine eigene Backend-Programmierung nötig.
- Free-Tier-Limits von Supabase (500 MB Datenbank, 50.000 monatliche aktive Nutzer) sind für eine Gruppe von 2–3 Freunden mehr als ausreichend.

## Erweiterungsideen für später

- Bild-Upload für eigene Karten-Scans (Zustand, Signatur o. ä.)
- Tauschbörse: Karten als „zum Tausch verfügbar" markieren
- Deck-Listen aus der Sammlung zusammenstellen
- Export als CSV/Excel für Statistiken
