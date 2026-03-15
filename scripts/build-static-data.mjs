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

function normalizeDateKey(value) {
  const match = String(value || "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function normalizeTimeKey(value) {
  const match = String(value || "").trim().match(/^(\d{2}):(\d{2})/);
  if (!match) return "";
  return `${match[1]}:${match[2]}`;
}

function compareScheduledGames(a, b) {
  const dateComparison = normalizeDateKey(a.date).localeCompare(normalizeDateKey(b.date));
  if (dateComparison !== 0) return dateComparison;

  const timeComparison = normalizeTimeKey(a.time).localeCompare(normalizeTimeKey(b.time));
  if (timeComparison !== 0) return timeComparison;

  return getStableGameId(a).localeCompare(getStableGameId(b));
}

function getTeamKey(game) {
  return String(game?.teamId || game?.sourceLabel || "").trim();
}

function summarizeMatch(game) {
  return {
    home: game.home || "",
    away: game.away || "",
    competition: game.competition || "",
    date: game.date || "",
    time: game.time || "",
    ageGroup: game.ageGroup || "",
    spielId: game.spielId || game.matchId || "",
    stableId: getStableGameId(game),
    resolvedBy: game.resolvedBy || "",
    sourceLabel: game.sourceLabel || "",
    teamId: game.teamId || ""
  };
}

async function readPreviousExportGames() {
  try {
    const text = await fs.readFile(path.join(outputDir, "matches.json"), "utf8");
    const data = JSON.parse(text);
    return Array.isArray(data?.games) ? data.games : [];
  } catch (_error) {
    return [];
  }
}

function buildPreviousGamesByTeam(previousGames) {
  const map = new Map();

  for (const game of previousGames) {
    const teamKey = getTeamKey(game);
    if (!teamKey) continue;

    const summary = summarizeMatch(game);
    const current = map.get(teamKey);
    if (!current || compareScheduledGames(current, summary) < 0) {
      map.set(teamKey, summary);
    }
  }

  return map;
}

function pickPreviousMatch(game, previousGamesByTeam) {
  const currentStableId = getStableGameId(game);
  const candidates = [];

  if (game.previousMatch) {
    candidates.push(summarizeMatch(game.previousMatch));
  }

  const teamKey = getTeamKey(game);
  if (teamKey && previousGamesByTeam.has(teamKey)) {
    candidates.push(previousGamesByTeam.get(teamKey));
  }

  const validCandidates = candidates.filter(
    (candidate) =>
      candidate &&
      candidate.stableId !== currentStableId &&
      compareScheduledGames(candidate, game) < 0
  );

  if (!validCandidates.length) {
    return null;
  }

  validCandidates.sort(compareScheduledGames);
  return validCandidates[validCandidates.length - 1];
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
  const previousExportGames = await readPreviousExportGames();
  const previousGamesByTeam = buildPreviousGamesByTeam(previousExportGames);
  const generatedAt = new Date().toISOString();
  const staticGames = [];
  const lineupSnapshots = new Map();
  const exportTargets = new Map();

  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(lineupsDir, { recursive: true });

  function registerExportTarget(game) {
    if (!game || !game.home || !game.away) return;

    const stableId = getStableGameId(game);
    if (!exportTargets.has(stableId)) {
      exportTargets.set(stableId, { ...game, stableId });
    }
  }

  for (const game of games) {
    registerExportTarget(game);
    registerExportTarget(game.previousMatch);
  }

  for (const target of exportTargets.values()) {
    log(`Loading lineup for ${target.stableId} (${target.home} - ${target.away})`);

    let lineupData;
    try {
      lineupData = await fetchJson(buildLineupUrl(target));
    } catch (error) {
      lineupData = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        players: []
      };
    }

    const lineupPayload = {
      ...lineupData,
      stableId: target.stableId,
      generatedAt,
      game: {
        home: target.home || "",
        away: target.away || "",
        date: target.date || "",
        time: target.time || "",
        competition: target.competition || "",
        ageGroup: target.ageGroup || "",
        spielId: target.spielId || ""
      }
    };

    await fs.writeFile(
      path.join(lineupsDir, `${target.stableId}.json`),
      JSON.stringify(lineupPayload, null, 2),
      "utf8"
    );

    lineupSnapshots.set(target.stableId, lineupPayload);
  }

  for (const game of games) {
    const stableId = getStableGameId(game);
    const previousMatch = pickPreviousMatch(game, previousGamesByTeam);
    const previousStableId = previousMatch ? getStableGameId(previousMatch) : "";

    staticGames.push({
      ...game,
      stableId,
      lineupFile: `lineups/${stableId}.json`,
      previousMatch: previousMatch
        ? {
            ...previousMatch,
            stableId: previousStableId,
            lineupFile: `lineups/${previousStableId}.json`
          }
        : null
    });
  }

  const matchesPayload = {
    ok: true,
    generatedAt,
    votingWindow: matchesData?.votingWindow || null,
    count: staticGames.length,
    games: staticGames
  };

  const combinedPayload = {
    ...matchesPayload,
    games: staticGames.map((game) => ({
      ...game,
      lineup: lineupSnapshots.get(game.stableId) || null,
      previousMatch: game.previousMatch
        ? {
            ...game.previousMatch,
            lineup: lineupSnapshots.get(game.previousMatch.stableId) || null
          }
        : null
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
