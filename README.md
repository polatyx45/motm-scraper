# MOTM Scraper

Automatischer `fussball.de`-Scraper mit `Puppeteer` fuer das SC-Hassel-Voting.

## Start

```bash
npm install
npm start
```

Der Server laeuft dann auf:

```text
http://localhost:3000
```

Hinweis:

```text
Nach Aenderungen an den Abhaengigkeiten bitte einmal npm.cmd install neu ausfuehren.
Der erste OCR-Aufruf kann etwas laenger dauern.
Das gelernte Zeichen-Mapping wird in obfuscation-map.json gespeichert.
```

## Oracle Cloud Always Free

Wenn der Scraper dauerhaft online laufen soll, kannst du ihn auf einer Oracle-Cloud-VM deployen.

Empfohlen:

```text
Ubuntu 24.04 Always Free VM
1 oeffentliche IPv4-Adresse
Port 3000 freigeben oder besser per Nginx auf Port 80 weiterleiten
```

Auf der VM:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg chromium-browser
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Projekt kopieren, dann im Projektordner:

```bash
npm install
PORT=3000 PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser pm2 start server.js --name motm-scraper
pm2 save
pm2 startup
```

Pruefen:

```text
http://DEINE-IP:3000/matches
http://DEINE-IP:3000/lineup?home=SC%20Hassel&away=Beispiel
```

Im Frontend danach:

```javascript
const LINEUP_API = "https://DEINE-DOMAIN/lineup";
const TICKER_API = "https://DEINE-DOMAIN/matches";
```

Wichtig:

```text
Der Server unterstuetzt jetzt PUPPETEER_EXECUTABLE_PATH fuer System-Chromium.
Das ist fuer Oracle-VMs meist stabiler als der automatisch mitgelieferte Browser.
```

## GitHub Actions statt Dauer-Server

Wenn du keinen laufenden Server willst, kannst du das Projekt als eigenes GitHub-Repo nutzen und die Daten per GitHub Actions erzeugen lassen.

Wichtig:

```text
Das Repo-Root sollte der Ordner motm-scraper sein.
Der Workflow liegt in .github/workflows/update-motm-data.yml.
```

Der Workflow:

```text
startet den Scraper alle 4 Stunden
laedt /matches und alle benoetigten /lineup-Daten
schreibt statische JSON-Dateien nach static-data/
committet neue Daten automatisch ins Repo
```

Lokal testen:

```bash
npm run build:static
```

Danach findest du:

```text
static-data/matches.json
static-data/motm-data.json
static-data/lineups/<stableId>.json
```

Fuer das Frontend ist spaeter meist diese Struktur am einfachsten:

```javascript
const TICKER_API = "https://DEINE-URL/static-data/matches.json";
const LINEUP_BASE = "https://DEINE-URL/static-data/lineups";
```

Die Lineup-Datei pro Spiel kannst du dann ueber `stableId` laden:

```javascript
async function loadLineup(game) {
  const stableId = game.stableId || game.spielId || game.matchId || game.id;
  const data = await fetchJson(`${LINEUP_BASE}/${stableId}.json`);
  return Array.isArray(data.players) ? data.players : [];
}
```

## Test

```text
http://localhost:3000/lineup?matchId=02U2A4C4NO000000VS5489BTVV378D77&home=Eintracht%20Erle%20II&away=SC%20Hassel
```

## Training

```text
http://localhost:3000/train-week
```

Der Endpoint laeuft alle SC-Hassel-Spiele aus dem Wochenfeed durch und erweitert dabei das gespeicherte Mapping in `obfuscation-map.json`.

## Frontend

Dein Frontend kann statt des Apps-Script-Lineup-Endpoints diese URL verwenden:

```javascript
const LINEUP_API = "http://localhost:3000/lineup";
```

Fuer den Wochenfeed solltest du jetzt ebenfalls den lokalen Enricher verwenden, damit fehlende `spielId` automatisch aus den Teamseiten nachgezogen werden:

```javascript
const TICKER_API = "http://localhost:3000/matches";
```

Und die Ladefunktion so:

```javascript
async function loadLineup(game) {
  const matchId = getMatchId(game) || "";
  const url = `${LINEUP_API}?matchId=${encodeURIComponent(matchId)}&home=${encodeURIComponent(game.home || "")}&away=${encodeURIComponent(game.away || "")}&date=${encodeURIComponent(game.date || "")}&time=${encodeURIComponent(game.time || "")}&competition=${encodeURIComponent(game.competition || "")}`;
  const data = await fetchJson(url);
  return data.ok && Array.isArray(data.players) ? data.players : [];
}
```

In `showMatch(...)` dann:

```javascript
const rawPlayers = await loadLineup(game);
```
