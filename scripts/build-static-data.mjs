import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "static-data");
const lineupsDir = path.join(outputDir, "lineups");
const serverPort = process.env.PORT || "3000";
const serverOrigin = process.env.SCRAPER_BASE_URL || `http://127.0.0.1:${serverPort}`;

function log(message) {
  console.log(`[build-static] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00df/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getFallbackMatchId(game) {
  return slugify([game.home, game.away, game.date, game.time].join("-"));
}

function getStableGameId(game) {
  return game.spielId || game.matchId || game.id || getFallbackMatchId(game);
}

function buildLineupUrl(game) {
  const params = new URLSearchParams({
    matchId: String(game.spielId || game.matchId || game.id || ""),
    home: String(game.home || ""),
    away: String(game.away || ""),
    date: String(game.date || ""),
    time: String(game.time || ""),
    competition: String(game.competition || "")
  });

  return `${serverOrigin}/lineup?${params.toString()}`;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  const text = await response.text();

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!response.ok) {
    const details = data ? JSON.stringify(data).slice(0, 400) : text.slice(0, 400);
    throw new Error(`HTTP ${response.status} from ${url}: ${details}`);
  }

  return data;
}

async function waitForServer(timeoutMs = 120000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const data = await fetchJson(`${serverOrigin}/matches`);
      if (data?.ok) {
        return;
      }
    } catch (_error) {
      // wait until the local server is ready
    }

    await sleep(2000);
  }

  throw new Error("Timed out while waiting for the local scraper server.");
}

function pipeServerOutput(stream, prefix) {
  stream.on("data", (chunk) => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        console.log(`${prefix} ${line}`);
      }
    }
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;

  child.kill("SIGTERM");
  await sleep(1000);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await sleep(500);
  }
}

async function collectStaticData() {
  const matchesData = await fetchJson(`${serverOrigin}/matches`);
  const games = Array.isArray(matchesData?.games) ? matchesData.games : [];
  const generatedAt = new Date().toISOString();
  const staticGames = [];
  const lineupSnapshots = [];

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(lineupsDir, { recursive: true });

  for (const game of games) {
    const stableId = getStableGameId(game);
    log(`Loading lineup for ${stableId} (${game.home} - ${game.away})`);

    let lineupData;
    try {
      lineupData = await fetchJson(buildLineupUrl(game));
    } catch (error) {
      lineupData = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        players: []
      };
    }

    const lineupPayload = {
      ...lineupData,
      stableId,
      generatedAt,
      game: {
        home: game.home || "",
        away: game.away || "",
        date: game.date || "",
        time: game.time || "",
        competition: game.competition || "",
        ageGroup: game.ageGroup || "",
        spielId: game.spielId || ""
      }
    };

    await fs.writeFile(
      path.join(lineupsDir, `${stableId}.json`),
      JSON.stringify(lineupPayload, null, 2),
      "utf8"
    );

    lineupSnapshots.push({
      stableId,
      lineup: lineupPayload
    });

    staticGames.push({
      ...game,
      stableId,
      lineupFile: `lineups/${stableId}.json`
    });
  }

  const matchesPayload = {
    ok: true,
    generatedAt,
    count: staticGames.length,
    games: staticGames
  };

  const combinedPayload = {
    ...matchesPayload,
    games: staticGames.map((game) => ({
        ...game,
        lineup: lineupSnapshots.find((entry) => entry.stableId === game.stableId)?.lineup || null
      }))
  };

  await fs.writeFile(path.join(outputDir, "matches.json"), JSON.stringify(matchesPayload, null, 2), "utf8");
  await fs.writeFile(path.join(outputDir, "motm-data.json"), JSON.stringify(combinedPayload, null, 2), "utf8");
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: serverPort
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  pipeServerOutput(child.stdout, "[server]");
  pipeServerOutput(child.stderr, "[server]");

  try {
    await waitForServer();
    await collectStaticData();
    log("Static MOTM data written to static-data/.");
  } finally {
    await stopServer(child);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
