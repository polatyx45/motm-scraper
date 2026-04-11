import fs from "node:fs";
import path from "node:path";
import express from "express";
import puppeteer from "puppeteer";
import { createWorker, PSM } from "tesseract.js";

const app = express();
const PORT = process.env.PORT || 3000;
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "";
const CLUB_NAME = "sc hassel";
const CLUB_SITE_ORIGIN = "https://www.sc-hassel1919.de";
const LOCAL_TIME_ZONE = "Europe/Berlin";
const TICKER_API = "https://script.google.com/macros/s/AKfycbxPvHMRhLyOD1kwz5J2yr7KB9uubapD5QAMMB8bgUDblJaPpEUbI7E_z86YlkL9XmPLSA/exec?mode=week";
const MATCHES_STATIC_API = "https://polatyx45.github.io/motm-scraper/static-data/matches.json";
const HISTORY_STATIC_API = "https://polatyx45.github.io/motm-scraper/static-data/history.json";
const PROFILE_CACHE = new Map();
const OBFUSCATION_MAPS = new Map();
const MAP_FILE = path.join(process.cwd(), "obfuscation-map.json");
const ALL_PAGES_DIRS = [
  path.resolve(process.cwd(), "all-pages"),
  path.resolve(process.cwd(), "../all-pages")
];
const ALL_PAGES_DIR = ALL_PAGES_DIRS.find((pagesDir) => fs.existsSync(pagesDir)) || ALL_PAGES_DIRS[0];
const TEAM_PAGE_PATHS = [
  "/die-erste/",
  "/2-mannschaft/",
  "/3-mannschaft-2/",
  "/a-jugend/",
  "/a-jugend-ii/",
  "/b-jugend/",
  "/c-jugend/",
  "/d-jugend/",
  "/d-jugend-ii/",
  "/d-jugend-iii/",
  "/e-jugend/",
  "/e-jugend-ii/",
  "/f-jugend/",
  "/f-jugend-ii/",
  "/g-jugend/",
  "/damen/",
  "/die-alten-herren/",
  "/walking-football/"
];
const BAD_NAME_FRAGMENTS = [
  "die heimat",
  "amateurfußballs",
  "amateurfussballs",
  "daten aus",
  "verschiedenen",
  "basisprofil",
  "spielerprofil",
  "benutzerprofil",
  "fussball.de"
];
const REMOTE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  "accept-language": "de-DE,de;q=0.9,en;q=0.8"
};
const CLUB_PAGE_HTML_CACHE = new Map();
const WIDGET_HTML_CACHE = new Map();
const MATCHPLAN_HTML_CACHE = new Map();
const NEXT_GAMES_HTML_CACHE = new Map();
const FULL_SEASON_MATCHPLAN_HTML_CACHE = new Map();
const OBFUSCATION_CSS_CACHE = new Map();
const TEAM_SCHEDULE_CACHE = new Map();
const SCORE_TEXT_CACHE = new Map();
const TEAM_MATCH_INDEX_TTL_MS = 15 * 60 * 1000;
const TEAM_SCHEDULE_TTL_MS = 5 * 60 * 1000;
const MATCHES_LITE_TTL_MS = 2 * 60 * 1000;
const REMOTE_FETCH_TIMEOUT_MS = 15 * 60 * 1000;

let browserPromise = null;
let ocrWorkerPromise = null;
let scoreOcrWorkerPromise = null;
let teamMatchIndexCache = null;
let teamMatchIndexLoadedAt = 0;
let teamMatchIndexPromise = null;
let matchesLiteCache = null;
let matchesLiteLoadedAt = 0;
let matchesLitePromise = null;

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function parseDateKeyToUtc(dateKey) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0));
}

function shiftDateKey(dateKey, days) {
  const date = parseDateKeyToUtc(dateKey);
  if (!date) return "";
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getBerlinNowParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const weekdayMap = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}:${values.second}`,
    weekdayIndex: weekdayMap[values.weekday] || 1
  };
}

function getActiveVotingWindow(date = new Date()) {
  const localNow = getBerlinNowParts(date);
  const startDate = shiftDateKey(localNow.dateKey, -(localNow.weekdayIndex - 1));
  const endDate = shiftDateKey(startDate, 6);

  return {
    timeZone: LOCAL_TIME_ZONE,
    localDate: localNow.dateKey,
    localTime: localNow.time,
    startDate,
    endDate,
    switchesAtLocal: `${shiftDateKey(endDate, 1)} 00:00:00`
  };
}

function isDateWithinVotingWindow(value, votingWindow) {
  const dateKey = normalizeDateKey(value);
  if (!dateKey) return false;
  return dateKey >= votingWindow.startDate && dateKey <= votingWindow.endDate;
}

function getMatchDurationMinutes(ageGroup) {
  const text = normalizeComparableText(ageGroup);
  if (text.includes("a junior")) return 95;
  if (text.includes("b junior")) return 90;
  if (text.includes("c junior")) return 75;
  if (text.includes("d junior")) return 70;
  if (text.includes("e junior")) return 60;
  if (text.includes("f junior")) return 55;
  if (text.includes("g junior")) return 50;
  return 95;
}

function parseScheduledDateTime(game) {
  const dateKey = normalizeDateKey(game?.date);
  const timeKey = normalizeTimeKey(game?.time) || "00:00";
  if (!dateKey) return null;
  const date = new Date(`${dateKey}T${timeKey}:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasMatchEnded(game) {
  const kickoff = parseScheduledDateTime(game);
  if (!kickoff) return false;
  const endedAt = new Date(kickoff.getTime() + getMatchDurationMinutes(game?.ageGroup) * 60000);
  return endedAt <= new Date();
}

function isDateWithinNextDays(value, days = 7) {
  const dateKey = normalizeDateKey(value);
  const matchDate = parseDateKeyToUtc(dateKey);
  if (!matchDate) return false;

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12, 0, 0));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + days);

  return matchDate >= start && matchDate <= end;
}

function buildGameMergeKey(game) {
  const explicitId = String(game.spielId || game.matchId || "").trim();
  if (explicitId) return explicitId;

  return [
    normalizeComparableText(game.home),
    normalizeComparableText(game.away),
    normalizeDateKey(game.date),
    normalizeTimeKey(game.time)
  ].join("|");
}

function buildScheduleKey(game) {
  return [
    normalizeComparableText(game.home),
    normalizeComparableText(game.away),
    normalizeDateKey(game.date),
    normalizeTimeKey(game.time)
  ].join("|");
}

function deriveAgeGroupFromSourceLabel(label) {
  const value = normalizeComparableText(label);
  if (!value) return "";
  if (value.includes("a jugend")) return "A-Junioren";
  if (value.includes("b jugend")) return "B-Junioren";
  if (value.includes("c jugend")) return "C-Junioren";
  if (value.includes("d jugend")) return "D-Junioren";
  if (value.includes("e jugend")) return "E-Junioren";
  if (value.includes("f jugend")) return "F-Junioren";
  if (value.includes("g jugend")) return "G-Junioren";
  if (value.includes("damen")) return "Damen";
  if (value.includes("alte herren") || value.includes("alten herren")) return "Alte Herren";
  if (value.includes("walking football")) return "Walking Football";
  return "Herren";
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(value) {
  return decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableText(value) {
  return stripTags(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMatchUrl(matchId, home, away) {
  const slug = slugify(`${home}-${away}`);
  return `https://www.fussball.de/spiel/${slug}/-/spiel/${encodeURIComponent(matchId)}`;
}

function applyKnownMatchFixes(game) {
  const home = String(game.home || "").trim().toLowerCase();
  const away = String(game.away || "").trim().toLowerCase();
  const date = String(game.date || "").trim();
  const time = String(game.time || "").trim();

  if (
    home === "eintracht erle ii" &&
    away === "sc hassel" &&
    date === "15.03.2026" &&
    time === "09:00"
  ) {
    return {
      ...game,
      spielId: "02U2A4C4NO000000VS5489BTVV378D77"
    };
  }

  return game;
}

function isRelevantGame(game) {
  const haystack = `${game.home || ""} ${game.away || ""}`.toLowerCase();
  return haystack.includes("sc hassel");
}

function normalizeProfileUrl(url) {
  if (!url) return "";
  if (url === "#") return "";
  if (url.toLowerCase().startsWith("javascript:")) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.fussball.de${url}`;
  return `https://www.fussball.de/${url}`;
}

function isReadableName(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (text.length < 3) return false;
  if (/^sn$/i.test(text)) return false;
  if (/^spieler\b/i.test(text)) return false;
  return /^[\p{L}][\p{L} .'-]+$/u.test(text);
}

function isPersonLikeName(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!isReadableName(text)) return false;

  const lower = text.toLowerCase();
  if (BAD_NAME_FRAGMENTS.some((fragment) => lower.includes(fragment))) return false;

  const words = text.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  return words.every((word) => /^[\p{L}.'-]+$/u.test(word) && word.length >= 2);
}

function buildDisplayName(name, number) {
  const cleanNumber = String(number || "").trim();
  if (isPersonLikeName(name)) return name;
  if (cleanNumber) return `Spieler Nr. ${cleanNumber}`;
  return "Spieler";
}

function cleanOcrName(value) {
  return String(value || "")
    .replace(/[|/\\]+/g, " ")
    .replace(/[^\p{L}\p{M}\s.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractNameFromTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  const parts = text.split(/\s*[-|:]\s*/).map((item) => item.trim()).filter(Boolean);
  const candidates = [text, ...parts];

  for (const candidate of candidates) {
    const cleaned = candidate
      .replace(/\([^)]*\)/g, "")
      .replace(/\bBasisprofil\b/gi, "")
      .replace(/\bFUSSBALL\.DE\b/gi, "")
      .replace(/\bProfil\b/gi, "")
      .replace(/\bSpielerprofil\b/gi, "")
      .replace(/\bBenutzerprofil\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (isPersonLikeName(cleaned)) {
      return cleaned;
    }
  }

  return "";
}

function loadObfuscationMaps() {
  if (!fs.existsSync(MAP_FILE)) return;

  try {
    const raw = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
    for (const [key, value] of Object.entries(raw)) {
      OBFUSCATION_MAPS.set(key, new Map(Object.entries(value)));
    }
  } catch (_error) {
    // ignore broken cache and continue with an empty map
  }
}

function saveObfuscationMaps() {
  const output = {};

  for (const [key, value] of OBFUSCATION_MAPS.entries()) {
    output[key] = Object.fromEntries(value.entries());
  }

  fs.writeFileSync(MAP_FILE, JSON.stringify(output, null, 2), "utf8");
}

function getObfuscationMap(obfuscationKey) {
  if (!obfuscationKey) return null;
  if (!OBFUSCATION_MAPS.has(obfuscationKey)) {
    OBFUSCATION_MAPS.set(obfuscationKey, new Map());
  }
  return OBFUSCATION_MAPS.get(obfuscationKey);
}

function learnObfuscationMapping(obfuscationKey, rawName, realName) {
  if (!obfuscationKey || !rawName || !realName) return;

  const raw = String(rawName);
  const real = String(realName);
  if (raw.length !== real.length) return;

  const mapping = getObfuscationMap(obfuscationKey);
  if (!mapping) return;

  let changed = false;

  for (let i = 0; i < raw.length; i += 1) {
    const fromChar = raw[i];
    const toChar = real[i];

    if (fromChar === " " && toChar === " ") continue;
    if (!fromChar.trim() || !toChar.trim()) continue;

    if (!mapping.has(fromChar)) {
      mapping.set(fromChar, toChar);
      changed = true;
    }
  }

  if (changed) saveObfuscationMaps();
}

function decodeWithObfuscationMap(obfuscationKey, rawName) {
  const mapping = getObfuscationMap(obfuscationKey);
  if (!mapping || !rawName) return "";

  let unknownCount = 0;
  let decoded = "";

  for (const char of String(rawName)) {
    if (char === " ") {
      decoded += " ";
      continue;
    }

    if (mapping.has(char)) {
      decoded += mapping.get(char);
    } else {
      decoded += "?";
      unknownCount += 1;
    }
  }

  if (unknownCount > 0) return "";

  const clean = decoded.replace(/\s+/g, " ").trim();
  return isPersonLikeName(clean) ? clean : "";
}

function getMappingStats() {
  let totalKeys = 0;
  let totalChars = 0;

  for (const [, value] of OBFUSCATION_MAPS.entries()) {
    totalKeys += 1;
    totalChars += value.size;
  }

  return { totalKeys, totalChars };
}

function extractWidgetConfigsFromLocalPages() {
  if (!fs.existsSync(ALL_PAGES_DIR)) return [];

  const files = fs.readdirSync(ALL_PAGES_DIR).filter((file) => file.toLowerCase().endsWith(".html"));
  const widgets = [];

  for (const file of files) {
    const fullPath = path.join(ALL_PAGES_DIR, file);
    const html = fs.readFileSync(fullPath, "utf8");
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const label =
      stripTags(titleMatch?.[1] || "")
        .replace(/\s+[–-]\s+SC Buer-Hassel 1919 e\.V\.\s*$/i, "")
        .trim() || path.basename(file, ".html");

    const matches = html.matchAll(
      /<div[^>]+class=["'][^"']*fussballde_widget[^"']*["'][^>]+data-id=["']([^"']+)["'][^>]+data-type=["']([^"']+)["'][^>]*>/gi
    );

    for (const match of matches) {
      widgets.push({
        file,
        label,
        widgetId: String(match[1] || "").trim(),
        widgetType: String(match[2] || "").trim().toLowerCase()
      });
    }
  }

  return widgets.filter((item) => item.widgetId && item.widgetType === "table");
}

async function fetchText(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: REMOTE_HEADERS,
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`remote_http_${response.status}`);
  }

  return response.text();
}

function extractWidgetConfigsFromHtml(html, sourceName) {
  const widgets = [];
  const titleMatch = String(html || "").match(/<title>([\s\S]*?)<\/title>/i);
  const label =
    stripTags(titleMatch?.[1] || "")
      .replace(/\s+[â€“-]\s+SC Buer-Hassel 1919 e\.V\.\s*$/i, "")
      .trim() || sourceName;

  const matches = String(html || "").matchAll(
    /<div[^>]+class=["'][^"']*fussballde_widget[^"']*["'][^>]+data-id=["']([^"']+)["'][^>]+data-type=["']([^"']+)["'][^>]*>/gi
  );

  for (const match of matches) {
    widgets.push({
      file: sourceName,
      label,
      widgetId: String(match[1] || "").trim(),
      widgetType: String(match[2] || "").trim().toLowerCase()
    });
  }

  return widgets.filter((item) => item.widgetId && item.widgetType === "table");
}

async function fetchClubPageHtml(pagePath) {
  const normalizedPath = String(pagePath || "").trim();
  if (!normalizedPath) return "";

  if (CLUB_PAGE_HTML_CACHE.has(normalizedPath)) {
    return CLUB_PAGE_HTML_CACHE.get(normalizedPath);
  }

  const html = await fetchText(new URL(normalizedPath, CLUB_SITE_ORIGIN).toString());
  CLUB_PAGE_HTML_CACHE.set(normalizedPath, html);
  return html;
}

async function loadRemoteWidgetConfigs() {
  const widgets = [];

  for (const pagePath of TEAM_PAGE_PATHS) {
    try {
      const html = await fetchClubPageHtml(pagePath);
      widgets.push(...extractWidgetConfigsFromHtml(html, pagePath));
    } catch (_error) {
      // ignore broken team pages and continue with the remaining ones
    }
  }

  return widgets;
}

async function loadWidgetConfigs() {
  const localWidgets = extractWidgetConfigsFromLocalPages();
  if (localWidgets.length) return localWidgets;
  return loadRemoteWidgetConfigs();
}

function extractNextData(html) {
  const match = String(html || "").match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i
  );

  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (_error) {
    return null;
  }
}

async function fetchWidgetHtml(widgetId) {
  if (WIDGET_HTML_CACHE.has(widgetId)) {
    return WIDGET_HTML_CACHE.get(widgetId);
  }

  const html = await fetchText(`https://next.fussball.de/widget/table/${encodeURIComponent(widgetId)}`);
  WIDGET_HTML_CACHE.set(widgetId, html);
  return html;
}

async function fetchTeamMatchplanHtml(teamId) {
  if (MATCHPLAN_HTML_CACHE.has(teamId)) {
    return MATCHPLAN_HTML_CACHE.get(teamId);
  }

  const html = await fetchText(
    `https://www.fussball.de/ajax.team.matchplan/-/mode/PAGE/team-id/${encodeURIComponent(teamId)}`
  );
  MATCHPLAN_HTML_CACHE.set(teamId, html);
  return html;
}

function getCurrentSeasonDateRange() {
  const dateKey = getBerlinNowParts().dateKey;
  const year = Number(dateKey.slice(0, 4));
  const month = Number(dateKey.slice(5, 7));
  const seasonStartYear = month >= 7 ? year : year - 1;

  return {
    dateFrom: `01.07.${seasonStartYear}`,
    dateTo: `30.06.${seasonStartYear + 1}`
  };
}

async function fetchFullSeasonTeamMatchplanHtml(teamId, { force = false } = {}) {
  const { dateFrom, dateTo } = getCurrentSeasonDateRange();
  const cacheKey = `${teamId}|${dateFrom}|${dateTo}`;

  if (!force && FULL_SEASON_MATCHPLAN_HTML_CACHE.has(cacheKey)) {
    return FULL_SEASON_MATCHPLAN_HTML_CACHE.get(cacheKey);
  }

  const url =
    `https://www.fussball.de/ajax.team.matchplan/-/mime-type/JSON/mode/PAGE/prev-season-allowed/false/show-filter/false/team-id/${encodeURIComponent(teamId)}` +
    `?datum-von=${encodeURIComponent(dateFrom)}&datum-bis=${encodeURIComponent(dateTo)}&max=200&offset=0`;
  const raw = await fetchText(url);
  let html = raw;

  try {
    const parsed = JSON.parse(raw);
    html = String(parsed?.html || "");
  } catch (_error) {
    html = raw;
  }

  FULL_SEASON_MATCHPLAN_HTML_CACHE.set(cacheKey, html);
  return html;
}

async function fetchTeamNextGamesHtml(teamId, { force = false } = {}) {
  const cacheEntry = NEXT_GAMES_HTML_CACHE.get(teamId);
  const isFresh = cacheEntry && Date.now() - cacheEntry.loadedAt < TEAM_SCHEDULE_TTL_MS;
  if (!force && isFresh) {
    return cacheEntry.html;
  }

  const html = await fetchText(
    `https://www.fussball.de/ajax.team.next.games/-/mode/PAGE/team-id/${encodeURIComponent(teamId)}`
  );
  NEXT_GAMES_HTML_CACHE.set(teamId, { html, loadedAt: Date.now() });
  return html;
}

async function fetchObfuscationStylesheet(obfuscationKey) {
  const cacheKey = String(obfuscationKey || "").trim();
  if (!cacheKey) return "";

  if (OBFUSCATION_CSS_CACHE.has(cacheKey)) {
    return OBFUSCATION_CSS_CACHE.get(cacheKey);
  }

  const css = (await fetchText(`https://www.fussball.de/export.fontface/-/id/${encodeURIComponent(cacheKey)}/type/css`))
    .replace(/url\('\/\//g, "url('https://")
    .replace(/url\(\"\/\//g, 'url("https://');

  OBFUSCATION_CSS_CACHE.set(cacheKey, css);
  return css;
}

function formatGermanDateLabel(dateValue) {
  const dateKey = normalizeDateKey(dateValue);
  const date = parseDateKeyToUtc(dateKey);
  if (!date) return String(dateValue || "").trim();

  return new Intl.DateTimeFormat("de-DE", {
    timeZone: LOCAL_TIME_ZONE,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function buildHideAfterValue(dateValue) {
  const dateKey = normalizeDateKey(dateValue);
  const nextDateKey = shiftDateKey(dateKey, 1);
  return nextDateKey ? `${nextDateKey}T00:00:00` : "";
}

function normalizeScoreOcrText(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[OoQD]/g, "0")
    .replace(/[Il|!]/g, "1")
    .replace(/S/g, "5")
    .replace(/Z/g, "2")
    .replace(/[：;]/g, ":");
  const scoreMatch = normalized.match(/\d{1,2}:\d{1,2}/);
  return scoreMatch ? scoreMatch[0] : "";
}

function encodeCharsForHtml(value) {
  return [...String(value || "")]
    .map((char) => `&#x${char.codePointAt(0).toString(16)};`)
    .join("");
}

function buildScoreCacheKey(obfuscationKey, leftValue, rightValue) {
  return [
    String(obfuscationKey || "").trim(),
    [...String(leftValue || "")].map((char) => char.codePointAt(0).toString(16)).join(","),
    [...String(rightValue || "")].map((char) => char.codePointAt(0).toString(16)).join(",")
  ].join("|");
}

function extractScheduleHeadline(segment) {
  const headlineMatch = String(segment || "").match(
    /<td colspan="6">([^,]+,\s*[0-9]{2}\.[0-9]{2}\.[0-9]{4})\s*-\s*([0-9]{2}:[0-9]{2})?\s*Uhr\s*\|\s*([^<]+)<\/td>/i
  );

  if (!headlineMatch) return null;

  return {
    date: headlineMatch[1].match(/([0-9]{2}\.[0-9]{2}\.[0-9]{4})/)?.[1] || "",
    time: String(headlineMatch[2] || "").trim(),
    competition: stripTags(headlineMatch[3])
  };
}

function extractScorePayload(scoreCellHtml) {
  const scoreCell = String(scoreCellHtml || "");
  const infoText = stripTags(scoreCell.match(/<span class="info-text">([\s\S]*?)<\/span>/i)?.[1] || "");
  const leftMatch = scoreCell.match(/<span([^>]*class="score-left"[^>]*)>([\s\S]*?)<\/span>/i);
  const rightMatch = scoreCell.match(
    /<span([^>]*class="score-right"[^>]*)>([\s\S]*?)(?:<span class="icon-verified"><\/span>)?<\/span>/i
  );
  const leftAttrs = leftMatch?.[1] || "";
  const rightAttrs = rightMatch?.[1] || "";
  const obfuscationKey =
    leftAttrs.match(/data-obfuscation="([^"]+)"/i)?.[1] ||
    rightAttrs.match(/data-obfuscation="([^"]+)"/i)?.[1] ||
    "";

  return {
    infoText,
    verified: /icon-verified/.test(scoreCell),
    obfuscationKey,
    leftValue: decodeHtmlEntities(stripTags(leftMatch?.[2] || "")),
    rightValue: decodeHtmlEntities(stripTags(rightMatch?.[2] || ""))
  };
}

function compareScheduleMatchesAscending(a, b) {
  const dateCompare = normalizeDateKey(a.date).localeCompare(normalizeDateKey(b.date));
  if (dateCompare !== 0) return dateCompare;
  return normalizeTimeKey(a.time).localeCompare(normalizeTimeKey(b.time));
}

function compareScheduleMatchesForDisplay(a, b) {
  if (a.isPast && b.isPast) {
    return compareScheduleMatchesAscending(b, a);
  }

  if (!a.isPast && !b.isPast) {
    return compareScheduleMatchesAscending(a, b);
  }

  return a.isPast ? -1 : 1;
}

function extractScheduleMatchesFromHtml(
  html,
  { teamId = "", label = "", clubName = CLUB_NAME, includePast = false } = {}
) {
  const segments = String(html || "").split('<tr class="row-headline visible-small">').slice(1);
  const matches = [];
  const normalizedClubName = normalizeComparableText(clubName);
  const todayKey = getBerlinNowParts().dateKey;

  for (const segment of segments) {
    const headline = extractScheduleHeadline(segment);
    const teamNames = [...segment.matchAll(/<div class="club-name">\s*([\s\S]*?)\s*<\/div>/gi)]
      .map((match) => stripTags(match[1]))
      .filter(Boolean);
    const logoUrls = [...segment.matchAll(/data-responsive-image="([^"]+)"/gi)]
      .map((match) => normalizeProfileUrl(match[1]))
      .filter(Boolean);
    const scoreCell = segment.match(/<td class="column-score">([\s\S]*?)<\/td>/i)?.[1] || "";
    const scorePayload = extractScorePayload(scoreCell);
    const matchUrlRaw =
      segment.match(/<a href="([^"]*\/spiel\/[^"]+)"/i)?.[1] ||
      segment.match(/<a href="([^"]+)"><span class="icon-angle-right hidden-full"/i)?.[1] ||
      "";
    const matchUrl = normalizeProfileUrl(matchUrlRaw);
    const matchId = matchUrl.match(/\/spiel\/([A-Z0-9]+)(?:$|[/?#"])/i)?.[1] || "";

    if (!headline || teamNames.length < 2 || !matchUrl) continue;

    const date = headline.date;
    const dateKey = normalizeDateKey(date);
    if (!dateKey) continue;
    const isPast = dateKey < todayKey;
    if (isPast && !includePast) continue;
    const time = headline.time;
    const competition = headline.competition;
    const home = teamNames[0];
    const away = teamNames[1];
    const isHomeTeam = normalizedClubName
      ? normalizeComparableText(home).includes(normalizedClubName)
      : false;
    const isAwayTeam = normalizedClubName
      ? normalizeComparableText(away).includes(normalizedClubName)
      : false;
    const venueType = isHomeTeam ? "home" : isAwayTeam ? "away" : "";

    matches.push({
      matchId,
      matchUrl,
      date,
      dateLabel: formatGermanDateLabel(date),
      time,
      competition,
      home,
      away,
      homeLogo: logoUrls[0] || "",
      awayLogo: logoUrls[1] || "",
      venueType,
      teamId,
      sourceLabel: label,
      hideAfter: buildHideAfterValue(date),
      isPast,
      status: isPast ? "past" : "upcoming",
      resultDisplay: scorePayload.infoText || "",
      resultType: scorePayload.infoText ? "info" : "",
      resultVerified: scorePayload.verified,
      resultObfuscationKey: scorePayload.obfuscationKey,
      resultLeftValue: scorePayload.leftValue,
      resultRightValue: scorePayload.rightValue
    });
  }

  return matches.sort(compareScheduleMatchesForDisplay);
}

function extractUpcomingMatchesFromNextGamesHtml(html, options = {}) {
  return extractScheduleMatchesFromHtml(html, options);
}

function extractUpcomingMatchesFromMatchplanHtml(html, options = {}) {
  return extractScheduleMatchesFromHtml(html, options);
}

async function getScoreOcrWorker() {
  if (!scoreOcrWorkerPromise) {
    scoreOcrWorkerPromise = (async () => {
      const worker = await createWorker("eng");
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: "0123456789:"
      });
      return worker;
    })();
  }

  return scoreOcrWorkerPromise;
}

async function decodeObfuscatedScore(obfuscationKey, leftValue, rightValue) {
  const cacheKey = buildScoreCacheKey(obfuscationKey, leftValue, rightValue);
  if (SCORE_TEXT_CACHE.has(cacheKey)) {
    return SCORE_TEXT_CACHE.get(cacheKey);
  }

  const css = await fetchObfuscationStylesheet(obfuscationKey);
  if (!css) return "";

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1200, height: 420, deviceScaleFactor: 3 });
    await page.setContent(
      `<!doctype html>
        <html lang="de">
          <head>
            <meta charset="utf-8" />
          <style>
            ${css}
              html, body {
                margin: 0;
                background: #ffffff;
              }
              .score-side {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 48px 64px;
                color: #000000;
                font-family: font-${obfuscationKey}, Arial, sans-serif;
                font-size: 220px;
                font-weight: 700;
                line-height: 1;
                background: #ffffff;
              }
            </style>
          </head>
          <body>
            <div id="left" class="score-side">${encodeCharsForHtml(leftValue)}</div>
            <div id="right" class="score-side">${encodeCharsForHtml(rightValue)}</div>
          </body>
        </html>`,
        { waitUntil: "networkidle0" }
      );
    await page.evaluate(() => document.fonts.ready);

    const leftHandle = await page.$("#left");
    const rightHandle = await page.$("#right");
    if (!leftHandle || !rightHandle) return "";

    const worker = await getScoreOcrWorker();
    const [leftImage, rightImage] = await Promise.all([
      leftHandle.screenshot({ type: "png" }),
      rightHandle.screenshot({ type: "png" })
    ]);
    const [leftResult, rightResult] = await Promise.all([
      worker.recognize(leftImage),
      worker.recognize(rightImage)
    ]);
    const leftDigits = String(leftResult?.data?.text || "").replace(/\D+/g, "").trim();
    const rightDigits = String(rightResult?.data?.text || "").replace(/\D+/g, "").trim();
    const decoded = leftDigits && rightDigits ? `${leftDigits}:${rightDigits}` : "";

    if (decoded) {
      SCORE_TEXT_CACHE.set(cacheKey, decoded);
    }

    return decoded;
  } finally {
    await page.close();
  }
}

async function inspectObfuscatedScoreDecoding(obfuscationKey, leftValue, rightValue) {
  const css = await fetchObfuscationStylesheet(obfuscationKey);
  if (!css) {
    return {
      ok: false,
      error: "missing_css",
      obfuscationKey,
      leftValue,
      rightValue,
      leftRawText: "",
      rightRawText: "",
      decoded: ""
    };
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1200, height: 420, deviceScaleFactor: 3 });
    await page.setContent(
      `<!doctype html>
        <html lang="de">
          <head>
            <meta charset="utf-8" />
            <style>
              ${css}
              html, body {
                margin: 0;
                background: #ffffff;
              }
              .score-side {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                padding: 48px 64px;
                color: #000000;
                font-family: font-${obfuscationKey}, Arial, sans-serif;
                font-size: 220px;
                font-weight: 700;
                line-height: 1;
                background: #ffffff;
              }
            </style>
          </head>
          <body>
            <div id="left" class="score-side">${encodeCharsForHtml(leftValue)}</div>
            <div id="right" class="score-side">${encodeCharsForHtml(rightValue)}</div>
          </body>
        </html>`,
      { waitUntil: "networkidle0" }
    );
    await page.evaluate(() => document.fonts.ready);

    const leftHandle = await page.$("#left");
    const rightHandle = await page.$("#right");
    if (!leftHandle || !rightHandle) {
      return {
        ok: false,
        error: "missing_rendered_score_handles",
        obfuscationKey,
        leftValue,
        rightValue,
        leftRawText: "",
        rightRawText: "",
        decoded: ""
      };
    }

    const worker = await getScoreOcrWorker();
    const [leftImage, rightImage] = await Promise.all([
      leftHandle.screenshot({ type: "png" }),
      rightHandle.screenshot({ type: "png" })
    ]);
    const [leftResult, rightResult] = await Promise.all([
      worker.recognize(leftImage),
      worker.recognize(rightImage)
    ]);
    const leftRawText = String(leftResult?.data?.text || "");
    const rightRawText = String(rightResult?.data?.text || "");
    const leftDigits = leftRawText.replace(/\D+/g, "").trim();
    const rightDigits = rightRawText.replace(/\D+/g, "").trim();

    return {
      ok: true,
      obfuscationKey,
      leftValue,
      rightValue,
      leftRawText,
      rightRawText,
      leftDigits,
      rightDigits,
      decoded: leftDigits && rightDigits ? `${leftDigits}:${rightDigits}` : ""
    };
  } finally {
    await page.close();
  }
}

function normalizeRenderedScore(value) {
  const withoutHalfTime = String(value || "").replace(/\[\d{1,2}\s*:\s*\d{1,2}\]/g, " ");
  const scoreMatch = normalizeScoreOcrText(withoutHalfTime);
  return scoreMatch || "";
}

function extractRenderedScoreFromHtml(html) {
  const source = String(html || "");
  if (!source) return null;

  const endResultMatch = source.match(
    /<span class="end-result">[\s\S]*?<span([^>]*)class="score-left"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<span([^>]*)class="score-right"[^>]*>([\s\S]*?)<\/span>/i
  );

  if (endResultMatch) {
    const leftAttrs = endResultMatch[1] || "";
    const leftValue = decodeHtmlEntities(stripTags(endResultMatch[2] || ""));
    const rightAttrs = endResultMatch[3] || "";
    const rightValue = decodeHtmlEntities(stripTags(endResultMatch[4] || ""));
    const obfuscationKey =
      leftAttrs.match(/data-obfuscation="([^"]+)"/i)?.[1] ||
      rightAttrs.match(/data-obfuscation="([^"]+)"/i)?.[1] ||
      "";

    return {
      obfuscationKey,
      leftValue,
      rightValue,
      text: stripTags(endResultMatch[0] || "")
    };
  }

  const resultBlockMatch = source.match(/<div class="result">([\s\S]*?)<\/div>/i);
  if (!resultBlockMatch) return null;

  return {
    obfuscationKey: "",
    leftValue: "",
    rightValue: "",
    text: stripTags(resultBlockMatch[1] || "")
  };
}

function extractScoreFromMatchEventsHtml(html) {
  const source = String(html || "");
  if (!source) return "";

  const match = source.match(/data-match-events="([^"]+)"/i);
  if (!match?.[1]) return "";

  const raw = decodeHtmlEntities(match[1]);
  const homeGoals = (raw.match(/'type':'goal','team':'home'/g) || []).length;
  const awayGoals = (raw.match(/'type':'goal','team':'away'/g) || []).length;

  if (homeGoals === 0 && awayGoals === 0) return "";
  return `${homeGoals}:${awayGoals}`;
}

async function extractRenderedMatchScorePayload(page) {
  return page.evaluate(() => {
    function buildPayload(leftNode, rightNode, textSource) {
      if (!leftNode || !rightNode) return null;

      const leftValue = (leftNode.textContent || "").trim();
      const rightValue = (rightNode.textContent || "").trim();
      const obfuscationKey =
        leftNode.getAttribute("data-obfuscation") ||
        rightNode.getAttribute("data-obfuscation") ||
        "";
      const text = (textSource?.textContent || "").trim();

      if (!leftValue && !rightValue && !text) return null;

      return {
        obfuscationKey,
        leftValue,
        rightValue,
        text
      };
    }

    const selectorPairs = [
      [
        ".stage-body .result .end-result .score-left",
        ".stage-body .result .end-result .score-right",
        ".stage-body .result .end-result"
      ],
      [
        "#course-quick-view .result .home-goals",
        "#course-quick-view .result .away-goals",
        "#course-quick-view .result"
      ],
      [
        ".match-course-quick-view .result .home-goals",
        ".match-course-quick-view .result .away-goals",
        ".match-course-quick-view .result"
      ]
    ];

    for (const [leftSelector, rightSelector, textSelector] of selectorPairs) {
      const payload = buildPayload(
        document.querySelector(leftSelector),
        document.querySelector(rightSelector),
        document.querySelector(textSelector)
      );
      if (payload) return payload;
    }

    const scoreTextSelectors = [
      ".stage-body .result .end-result",
      "#course-quick-view .result",
      ".match-course-quick-view .result"
    ];

    for (const selector of scoreTextSelectors) {
      const node = document.querySelector(selector);
      const text = (node?.textContent || "").trim();
      if (text) {
        return {
          obfuscationKey: "",
          leftValue: "",
          rightValue: "",
          text
        };
      }
    }

    return null;
  });
}

async function extractScoreFromRenderedElement(page) {
  const scoreHandle =
    (await page.$(".stage-body .result .end-result")) ||
    (await page.$("#course-quick-view .result")) ||
    (await page.$(".match-course-quick-view .result"));

  if (!scoreHandle) return "";

  try {
    await scoreHandle.evaluate((node) => {
      node.scrollIntoView({ block: "center", inline: "center" });
    });
    const image = await scoreHandle.screenshot({ type: "png" });
    const worker = await getScoreOcrWorker();
    const result = await worker.recognize(image);
    return normalizeScoreOcrText(result?.data?.text || "");
  } catch (_error) {
    return "";
  }
}

async function inspectRenderedMatchScore(match) {
  const matchId = String(match?.matchId || match?.spielId || "").trim();
  const home = String(match?.home || "").trim();
  const away = String(match?.away || "").trim();
  const url = buildMatchUrl(matchId, home, away);
  const details = {
    matchId,
    home,
    away,
    url,
    html: {
      payload: null,
      decodedScore: "",
      normalizedScore: ""
    },
    rendered: {
      payload: null,
      decodedScore: "",
      normalizedScore: "",
      ocrScore: ""
    },
    finalScore: ""
  };

  try {
    const html = await fetchText(url);
    const htmlScorePayload = extractRenderedScoreFromHtml(html);
    details.html.payload = htmlScorePayload;
    details.html.eventsScore = extractScoreFromMatchEventsHtml(html);

    if (
      htmlScorePayload?.obfuscationKey &&
      (htmlScorePayload.leftValue || htmlScorePayload.rightValue)
    ) {
      const decodeDetails = await inspectObfuscatedScoreDecoding(
        htmlScorePayload.obfuscationKey,
        htmlScorePayload.leftValue,
        htmlScorePayload.rightValue
      );
      details.html.decodeDetails = decodeDetails;
      details.html.decodedScore = decodeDetails.decoded || "";
    }

    details.html.normalizedScore = normalizeRenderedScore(htmlScorePayload?.text || "");
  } catch (error) {
    details.html.error = error instanceof Error ? error.message : String(error);
  }

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1800, height: 1800, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(() => {
      return Boolean(
        document.querySelector(".stage-body .result .end-result .score-left") ||
        document.querySelector("#course-quick-view .result .home-goals") ||
        document.querySelector(".match-course-quick-view .result .home-goals") ||
        document.querySelector(".stage-body .result .end-result")
      );
    }, { timeout: 15000 });

    await page.addStyleTag({
      content: `
        .stage-body .result .end-result,
        #course-quick-view .result,
        .match-course-quick-view .result {
          color: #000 !important;
          background: #fff !important;
          text-shadow: none !important;
          filter: contrast(2);
          transform: scale(1.8);
          transform-origin: center center;
          display: inline-flex !important;
          align-items: center;
          justify-content: center;
          padding: 12px 16px;
          border-radius: 8px;
        }
      `
    });

    details.rendered.payload = await extractRenderedMatchScorePayload(page);

    if (
      details.rendered.payload?.obfuscationKey &&
      (details.rendered.payload.leftValue || details.rendered.payload.rightValue)
    ) {
      const decodeDetails = await inspectObfuscatedScoreDecoding(
        details.rendered.payload.obfuscationKey,
        details.rendered.payload.leftValue,
        details.rendered.payload.rightValue
      );
      details.rendered.decodeDetails = decodeDetails;
      details.rendered.decodedScore = decodeDetails.decoded || "";
    }

    details.rendered.normalizedScore = normalizeRenderedScore(details.rendered.payload?.text || "");
    details.rendered.ocrScore = await extractScoreFromRenderedElement(page);
  } catch (error) {
    details.rendered.error = error instanceof Error ? error.message : String(error);
  } finally {
    await page.close();
  }

  details.finalScore =
    details.html.eventsScore ||
    details.html.decodedScore ||
    details.html.normalizedScore ||
    details.rendered.decodedScore ||
    details.rendered.normalizedScore ||
    details.rendered.ocrScore ||
    "";

  return details;
}

async function extractRenderedMatchScore(match) {
  const matchId = String(match?.matchId || match?.spielId || "").trim();
  const home = String(match?.home || "").trim();
  const away = String(match?.away || "").trim();
  if (!matchId || !home || !away) return "";

  try {
    const details = await inspectRenderedMatchScore(match);
    if (details.html.eventsScore) return details.html.eventsScore;
    if (details.rendered.ocrScore) return details.rendered.ocrScore;
    if (details.html.decodedScore) return details.html.decodedScore;
    if (details.rendered.decodedScore) return details.rendered.decodedScore;
    if (details.html.normalizedScore) return details.html.normalizedScore;
    if (details.rendered.normalizedScore) return details.rendered.normalizedScore;
    return details.finalScore || "";
  } catch (_error) {
    return "";
  }
}

async function hydratePastMatchResults(matches, { force = false } = {}) {
  const hydrated = [];

  for (const match of matches) {
    if (!match.isPast) {
      hydrated.push(match);
      continue;
    }

    if (!force && match.resultDisplay && !/ergebnis\s+offen/i.test(String(match.resultDisplay))) {
      hydrated.push(match);
      continue;
    }

    if (!match.resultObfuscationKey || (!match.resultLeftValue && !match.resultRightValue)) {
      const renderedScore = await extractRenderedMatchScore(match);
      hydrated.push({
        ...match,
        resultDisplay: renderedScore || "Ergebnis offen",
        resultType: renderedScore ? "score" : "info"
      });
      continue;
    }

    const decodedScore = await decodeObfuscatedScore(
      match.resultObfuscationKey,
      match.resultLeftValue,
      match.resultRightValue
    );
    const renderedScore = decodedScore ? "" : await extractRenderedMatchScore(match);
    const finalScore = decodedScore || renderedScore;

    hydrated.push({
      ...match,
      resultDisplay: finalScore || "Ergebnis offen",
      resultType: finalScore ? "score" : "info"
    });
  }

  return hydrated;
}

async function fetchJsonWithHeaders(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: REMOTE_HEADERS,
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`json_http_${response.status}`);
  }
  return response.json();
}

async function loadStaticLiveTickerBaseData() {
  const votingWindow = getActiveVotingWindow();
  const [matchesData, historyData] = await Promise.all([
    fetchJsonWithHeaders(MATCHES_STATIC_API),
    fetchJsonWithHeaders(HISTORY_STATIC_API).catch(() => ({ games: [] }))
  ]);

  const games = mergeGames([
    ...(Array.isArray(historyData?.games) ? historyData.games : []),
    ...(Array.isArray(matchesData?.games) ? matchesData.games : [])
  ])
    .filter(isRelevantGame)
    .filter((game) => isDateWithinVotingWindow(game.date, votingWindow))
    .sort(compareScheduledGames);

  return {
    votingWindow,
    games
  };
}

function extractWidgetEntries(html) {
  const data = extractNextData(html);
  const entries = data?.props?.pageProps?.table?.entries;
  return Array.isArray(entries) ? entries : [];
}

function detectPrimaryClubId(widgetBundles) {
  const counts = new Map();

  for (const bundle of widgetBundles) {
    for (const entry of bundle.entries) {
      const clubId = String(entry?.clubId || "").trim();
      if (!clubId) continue;
      counts.set(clubId, (counts.get(clubId) || 0) + 1);
    }
  }

  let bestClubId = "";
  let bestCount = 0;

  for (const [clubId, count] of counts.entries()) {
    if (count > bestCount) {
      bestClubId = clubId;
      bestCount = count;
    }
  }

  return bestClubId;
}

function extractMatchesFromMatchplanHtml(html, teamMeta) {
  const segments = String(html || "").split('<tr class="row-headline visible-small">').slice(1);
  const matches = [];

  for (const segment of segments) {
    const headlineMatch = segment.match(
      /<td colspan="6">[^,]+,\s*([0-9]{2}\.[0-9]{2}\.[0-9]{4})\s*-\s*([0-9]{2}:[0-9]{2})\s*Uhr\s*\|\s*([^<]+)<\/td>/i
    );
    const teamNames = [...segment.matchAll(/<div class="club-name">\s*([\s\S]*?)\s*<\/div>/gi)]
      .map((match) => stripTags(match[1]))
      .filter(Boolean);
    const logoUrls = [...segment.matchAll(/data-responsive-image="([^"]+)"/gi)]
      .map((match) => normalizeProfileUrl(match[1]))
      .filter(Boolean);
    const matchId =
      segment.match(/href="https:\/\/www\.fussball\.de\/spiel\/[^"]*\/spiel\/([A-Z0-9]+)"/i)?.[1] || "";

    if (!headlineMatch || teamNames.length < 2 || !matchId) continue;

    matches.push({
      matchId,
      date: headlineMatch[1],
      time: headlineMatch[2],
      competition: stripTags(headlineMatch[3]),
      home: teamNames[0],
      away: teamNames[1],
      homeLogo: logoUrls[0] || "",
      awayLogo: logoUrls[1] || "",
      teamId: teamMeta.teamId,
      widgetId: teamMeta.widgetId,
      sourceLabel: teamMeta.label
    });
  }

  return matches;
}

async function loadTeamMatchIndex({ force = false } = {}) {
  const isFresh = teamMatchIndexCache && Date.now() - teamMatchIndexLoadedAt < TEAM_MATCH_INDEX_TTL_MS;
  if (!force && isFresh) {
    return teamMatchIndexCache;
  }

  if (teamMatchIndexPromise) {
    return teamMatchIndexPromise;
  }

  teamMatchIndexPromise = (async () => {
    const widgetConfigs = await loadWidgetConfigs();
    const widgetBundles = [];

    for (const config of widgetConfigs) {
      try {
        const html = await fetchWidgetHtml(config.widgetId);
        const entries = extractWidgetEntries(html);
        if (entries.length) {
          widgetBundles.push({ ...config, entries });
        }
      } catch (_error) {
        // ignore broken widgets and continue with the remaining ones
      }
    }

    const primaryClubId = detectPrimaryClubId(widgetBundles);
    const seenTeamIds = new Set();
    const teamEntries = [];

    for (const bundle of widgetBundles) {
      const preferredEntries = bundle.entries.filter(
        (entry) => String(entry?.clubId || "").trim() === primaryClubId
      );
      const selected = preferredEntries[0] || bundle.entries[0];
      const teamId = String(selected?.teamPermanentId || "").trim();

      if (!teamId || seenTeamIds.has(teamId)) continue;
      seenTeamIds.add(teamId);

      teamEntries.push({
        label: bundle.label,
        file: bundle.file,
        widgetId: bundle.widgetId,
        teamId,
        clubId: String(selected?.clubId || "").trim()
      });
    }

    const matches = [];

    for (const teamMeta of teamEntries) {
      try {
        const html = await fetchFullSeasonTeamMatchplanHtml(teamMeta.teamId);
        matches.push(...extractMatchesFromMatchplanHtml(html, teamMeta));
      } catch (_error) {
        // ignore broken team pages and continue with the remaining ones
      }
    }

    teamMatchIndexCache = {
      primaryClubId,
      teams: teamEntries,
      matches
    };
    teamMatchIndexLoadedAt = Date.now();

    return teamMatchIndexCache;
  })();

  try {
    return await teamMatchIndexPromise;
  } finally {
    teamMatchIndexPromise = null;
  }
}

function pickBestResolvedMatch(query, matches) {
  const explicitMatchId = String(query.spielId || query.matchId || "").trim();
  if (explicitMatchId) {
    const byMatchId = matches.find((match) => String(match.matchId || "").trim() === explicitMatchId);
    if (byMatchId) return byMatchId;
  }

  const normalizedHome = normalizeComparableText(query.home);
  const normalizedAway = normalizeComparableText(query.away);
  if (!normalizedHome || !normalizedAway) return null;

  let candidates = matches.filter(
    (match) =>
      normalizeComparableText(match.home) === normalizedHome &&
      normalizeComparableText(match.away) === normalizedAway
  );

  if (!candidates.length) return null;

  if (query.date) {
    const dated = candidates.filter((match) => String(match.date || "").trim() === String(query.date).trim());
    if (dated.length) candidates = dated;
  }

  if (query.time) {
    const timed = candidates.filter((match) => String(match.time || "").trim() === String(query.time).trim());
    if (timed.length) candidates = timed;
  }

  if (query.competition) {
    const competition = normalizeComparableText(query.competition);
    const competitionMatches = candidates.filter((match) => {
      const candidateCompetition = normalizeComparableText(match.competition);
      return (
        candidateCompetition === competition ||
        candidateCompetition.includes(competition) ||
        competition.includes(candidateCompetition)
      );
    });

    if (competitionMatches.length) candidates = competitionMatches;
  }

  return candidates.length === 1 ? candidates[0] : null;
}

async function resolveMatchFromTeamPages(query) {
  const index = await loadTeamMatchIndex();
  return pickBestResolvedMatch(query, index.matches);
}

async function enrichGamesWithResolvedMatchIds(games) {
  const enrichedGames = [];

  for (const game of games) {
    const alreadyEnriched = Boolean(
      (game.spielId || game.matchId) &&
      game.teamId &&
      game.sourceLabel &&
      game.homeLogo &&
      game.awayLogo
    );

    if (alreadyEnriched || !game.home || !game.away) {
      enrichedGames.push(game);
      continue;
    }

    const resolved = await resolveMatchFromTeamPages(game);
    if (resolved?.matchId) {
      enrichedGames.push({
        ...game,
        spielId: game.spielId || resolved.matchId,
        resolvedBy: game.resolvedBy || "team_matchplan",
        sourceLabel: game.sourceLabel || resolved.sourceLabel,
        teamId: game.teamId || resolved.teamId,
        homeLogo: game.homeLogo || resolved.homeLogo || "",
        awayLogo: game.awayLogo || resolved.awayLogo || ""
      });
    } else {
      enrichedGames.push(game);
    }
  }

  return enrichedGames;
}

function buildVotingGameFromTeamMatch(match) {
  return {
    home: match.home,
    away: match.away,
    homeLogo: match.homeLogo || "",
    awayLogo: match.awayLogo || "",
    competition: match.competition,
    date: match.date,
    time: match.time,
    ageGroup: deriveAgeGroupFromSourceLabel(match.sourceLabel),
    spielId: match.matchId,
    status: match.status || "",
    result: match.result || "",
    resultDisplay: match.resultDisplay || "",
    resultType: match.resultType || "",
    resolvedBy: "team_matchplan",
    sourceLabel: match.sourceLabel,
    teamId: match.teamId
  };
}

async function loadActiveVotingTeamGames(teamEntries, votingWindow) {
  const games = [];

  for (const teamMeta of teamEntries) {
    try {
      const matchplanHtml = await fetchFullSeasonTeamMatchplanHtml(teamMeta.teamId);
      const matches = extractUpcomingMatchesFromMatchplanHtml(matchplanHtml, {
        teamId: teamMeta.teamId,
        label: teamMeta.label,
        clubName: CLUB_NAME,
        includePast: true
      });
      const hydratedMatches = await hydratePastMatchResults(matches);

      games.push(
        ...hydratedMatches
          .filter((match) => isRelevantGame(match))
          .filter((match) => isDateWithinVotingWindow(match.date, votingWindow))
          .map(buildVotingGameFromTeamMatch)
      );
    } catch (_error) {
      // ignore broken team matchplans and continue with the remaining ones
    }
  }

  return games;
}

function compareScheduledGames(a, b) {
  const dateComparison = normalizeDateKey(a.date).localeCompare(normalizeDateKey(b.date));
  if (dateComparison !== 0) return dateComparison;

  const timeComparison = normalizeTimeKey(a.time).localeCompare(normalizeTimeKey(b.time));
  if (timeComparison !== 0) return timeComparison;

  return buildScheduleKey(a).localeCompare(buildScheduleKey(b));
}

function getGameTeamKey(game) {
  return String(game.teamId || game.sourceLabel || "").trim();
}

function getStableGameId(game) {
  return String(game.spielId || game.matchId || "").trim() ||
    slugify(`${game.home || ""}-${game.away || ""}-${game.date || ""}-${game.time || ""}`);
}

function summarizeMatch(match) {
  return {
    home: match.home,
    away: match.away,
    homeLogo: match.homeLogo || "",
    awayLogo: match.awayLogo || "",
    competition: match.competition,
    date: match.date,
    time: match.time,
    ageGroup: match.ageGroup || deriveAgeGroupFromSourceLabel(match.sourceLabel),
    spielId: match.spielId || match.matchId || "",
    status: match.status || "",
    result: match.result || "",
    resultDisplay: match.resultDisplay || "",
    resultType: match.resultType || "",
    resultVerified: Boolean(match.resultVerified),
    venueType: match.venueType || "",
    stableId: getStableGameId(match),
    resolvedBy: match.resolvedBy || "team_matchplan",
    sourceLabel: match.sourceLabel || "",
    teamId: match.teamId || ""
  };
}

function resolveTeamKeyForGame(game, teamMatches) {
  const explicitTeamKey = getGameTeamKey(game);
  if (explicitTeamKey) return explicitTeamKey;

  const explicitMatchId = String(game.spielId || game.matchId || "").trim();
  if (explicitMatchId) {
    const byMatchId = teamMatches.find((match) => String(match.matchId || "").trim() === explicitMatchId);
    if (byMatchId) return getGameTeamKey(byMatchId);
  }

  const scheduleKey = buildScheduleKey(game);
  const bySchedule = teamMatches.find((match) => buildScheduleKey(match) === scheduleKey);
  return bySchedule ? getGameTeamKey(bySchedule) : "";
}

function attachPreviousMatches(games, teamMatches) {
  const groupedMatches = new Map();

  for (const match of teamMatches.filter((item) => isRelevantGame(item))) {
    const teamKey = getGameTeamKey(match);
    if (!teamKey) continue;

    if (!groupedMatches.has(teamKey)) {
      groupedMatches.set(teamKey, []);
    }

    groupedMatches.get(teamKey).push(match);
  }

  for (const matches of groupedMatches.values()) {
    matches.sort(compareScheduledGames);
  }

  return games.map((game) => {
    const teamKey = resolveTeamKeyForGame(game, teamMatches);
    if (!teamKey || !groupedMatches.has(teamKey)) {
      return game;
    }

    const previousMatches = groupedMatches
      .get(teamKey)
      .filter((match) => compareScheduledGames(match, game) < 0);
    const previousMatch = previousMatches[previousMatches.length - 1];

    if (!previousMatch) {
      return game;
    }

    return {
      ...game,
      teamId: game.teamId || previousMatch.teamId || "",
      sourceLabel: game.sourceLabel || previousMatch.sourceLabel || "",
      previousMatch: summarizeMatch(previousMatch)
    };
  });
}

function mergeGames(games) {
  const merged = [];
  const seen = new Set();

  for (const game of games) {
    const key = buildGameMergeKey(game);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(game);
  }

  return merged;
}

async function getBrowser() {
  if (!browserPromise) {
    const launchOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote"
      ]
    };

    if (PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = PUPPETEER_EXECUTABLE_PATH;
    }

    browserPromise = puppeteer.launch(launchOptions);
  }
  return browserPromise;
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const worker = await createWorker("deu+eng");
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        preserve_interword_spaces: "1"
      });
      return worker;
    })();
  }

  return ocrWorkerPromise;
}

async function readNameWithOcr(nameHandle, number) {
  if (!nameHandle) return buildDisplayName("", number);

  const worker = await getOcrWorker();
  const image = await nameHandle.screenshot({ type: "png" });
  const result = await worker.recognize(image);
  const ocrName = cleanOcrName(result?.data?.text || "");

  if (isPersonLikeName(ocrName)) return ocrName;
  return buildDisplayName("", number);
}

async function resolveNameFromProfile(browser, href) {
  const url = normalizeProfileUrl(href);
  if (!url) return "";
  if (PROFILE_CACHE.has(url)) return PROFILE_CACHE.get(url);

  const page = await browser.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const profileCandidates = await page.evaluate(() => {
      const values = [
        document.querySelector("h1")?.textContent?.trim() || "",
        document.querySelector(".stage h1")?.textContent?.trim() || "",
        document.querySelector(".headline h1")?.textContent?.trim() || "",
        document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "",
        document.querySelector('meta[name="twitter:title"]')?.getAttribute("content") || "",
        document.querySelector("title")?.textContent?.trim() || ""
      ];

      return values.filter(Boolean);
    });

    for (const candidate of profileCandidates) {
      const resolved = extractNameFromTitle(candidate);
      if (resolved) {
        PROFILE_CACHE.set(url, resolved);
        return resolved;
      }
    }

    PROFILE_CACHE.set(url, "");
    return "";
  } catch (_error) {
    PROFILE_CACHE.set(url, "");
    return "";
  } finally {
    await page.close();
  }
}

async function loadWeekGamesData({ includeUnresolved = false, includePreviousMatches = true } = {}) {
  const votingWindow = getActiveVotingWindow();
  const response = await fetch(TICKER_API, {
    cache: "no-store",
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`ticker_http_${response.status}`);
  }

  const data = await response.json();
  const feedGames = (Array.isArray(data.games) ? data.games : [])
    .filter(isRelevantGame)
    .map(applyKnownMatchFixes)
    .filter((game) => isDateWithinVotingWindow(game.date, votingWindow));
  const resolvedFeedGames = await enrichGamesWithResolvedMatchIds(feedGames);
  const teamIndex = await loadTeamMatchIndex();
  const teamGames = (await loadActiveVotingTeamGames(teamIndex.teams, votingWindow)).map(applyKnownMatchFixes);
  const mergedGames = mergeGames([...teamGames, ...resolvedFeedGames]).filter((game) =>
    includeUnresolved ? game.home && game.away : game.spielId && game.home && game.away
  );
  const games = includePreviousMatches
    ? attachPreviousMatches(mergedGames, teamIndex.matches)
    : mergedGames;

  return {
    votingWindow,
    games
  };
}

async function loadHistoryWeekGamesData() {
  const votingWindow = getActiveVotingWindow();
  const response = await fetch(HISTORY_STATIC_API, {
    cache: "no-store",
    signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`history_http_${response.status}`);
  }

  const data = await response.json();
  const historyGames = (Array.isArray(data.games) ? data.games : [])
    .filter(isRelevantGame)
    .map(applyKnownMatchFixes)
    .filter((game) => isDateWithinVotingWindow(game.date, votingWindow));
  const resolvedHistoryGames = await enrichGamesWithResolvedMatchIds(historyGames);

  return {
    votingWindow,
    games: resolvedHistoryGames
  };
}

async function loadWeekGames(options) {
  const data = await loadWeekGamesData(options);
  return data.games;
}

async function loadCachedMatchesLiteData() {
  const isFresh = matchesLiteCache && Date.now() - matchesLiteLoadedAt < MATCHES_LITE_TTL_MS;
  if (isFresh) {
    return matchesLiteCache;
  }

  if (matchesLitePromise) {
    return matchesLitePromise;
  }

  matchesLitePromise = (async () => {
    try {
      const baseData = await loadStaticLiveTickerBaseData();
      const hydratedGames = await hydratePastMatchResults(
        baseData.games.map((game) => ({
          ...game,
          isPast: hasMatchEnded(game)
        })),
        { force: true }
      );
      const data = {
        votingWindow: baseData.votingWindow,
        games: hydratedGames
      };
      matchesLiteCache = data;
      matchesLiteLoadedAt = Date.now();
      return data;
    } finally {
      matchesLitePromise = null;
    }
  })();

  return matchesLitePromise;
}

async function scrapeLineup({ matchId, home, away }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const url = buildMatchUrl(matchId, home, away);
  const lineupSelector = ".player-wrapper.home, .player-wrapper.away";

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1440, height: 1600 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      (selector) =>
        Boolean(
          document.querySelector(selector) ||
            document.querySelector("#course") ||
            document.querySelector(".stage-body") ||
            document.querySelector('a[href*="ajax.match.lineup"]')
        ),
      { timeout: 30000 },
      lineupSelector
    );
    await page.addStyleTag({
      content: `
        .player-wrapper .player-name {
          background: #ffffff !important;
          color: #000000 !important;
          padding: 10px 14px !important;
          border-radius: 8px !important;
          text-shadow: none !important;
          box-shadow: none !important;
          display: inline-block !important;
        }
      `
    });

    const lineupTab = await page.$('a[href*="ajax.match.lineup"]');
    if (lineupTab) {
      await lineupTab.evaluate((node) => {
        node.scrollIntoView({ block: "center", inline: "center" });
      });

      await Promise.allSettled([
        page.waitForSelector(lineupSelector, { timeout: 30000 }),
        lineupTab.click()
      ]);
    } else {
      await page.waitForSelector(lineupSelector, { timeout: 30000 });
    }

    const playerWrapperExists = await page.$(lineupSelector);
    if (!playerWrapperExists) {
      const pageState = await page.evaluate(() => ({
        title: document.title || "",
        bodyText: document.body?.innerText?.slice(0, 500) || ""
      }));
      throw new Error(
        `lineup_not_available: ${pageState.title || "unknown_page"} | ${pageState.bodyText}`
      );
    }

    const { ownSide } = await page.evaluate((clubName) => {
      const homeName =
        document.querySelector(".stage-body .team-home .team-name")?.textContent?.trim() ||
        document.querySelector("#course .head .home .club-name")?.textContent?.trim() ||
        "";

      return {
        ownSide: homeName.toLowerCase().includes(clubName) ? "home" : "away"
      };
    }, CLUB_NAME);

    const playerHandles = await page.$$(`.player-wrapper.${ownSide}`);
    const players = [];

    for (const handle of playerHandles) {
      const meta = await handle.evaluate((node, side) => {
        const href = node.getAttribute("href") || "";
        const firstNameNode = node.querySelector(".firstname");
        const lastNameNode = node.querySelector(".lastname");
        const firstName = firstNameNode?.textContent?.trim() || "";
        const lastName = lastNameNode?.textContent?.trim() || "";
        const number = node.querySelector(".player-number")?.textContent?.trim() || "";
        const img =
          node.querySelector("[data-responsive-image]")?.getAttribute("data-responsive-image") || "";
        const obfuscationKey =
          firstNameNode?.getAttribute("data-obfuscation") ||
          lastNameNode?.getAttribute("data-obfuscation") ||
          "";

        const idMatch = href.match(/(?:player-id|userid)\/([A-Z0-9]+)/i);
        const rawName = [firstName, lastName].join(" ").replace(/\s+/g, " ").trim() || "k.A.";
        const id = idMatch ? idMatch[1] : `${side}_${rawName}_${number}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_");

        return {
          id,
          href,
          side,
          rawName,
          number,
          img,
          obfuscationKey
        };
      }, ownSide);

      players.push(meta);
    }

    for (const player of players) {
      const mapped = decodeWithObfuscationMap(player.obfuscationKey, player.rawName);
      if (isPersonLikeName(mapped)) {
        player.decodedName = mapped;
        continue;
      }

      if (String(player.rawName).trim().toLowerCase() === "k.a.") continue;

      const resolved = await resolveNameFromProfile(browser, player.href);
      if (isPersonLikeName(resolved)) {
        player.decodedName = resolved;
        learnObfuscationMapping(player.obfuscationKey, player.rawName, resolved);
      }
    }

    for (const player of players) {
      if (isPersonLikeName(player.decodedName)) continue;

      const mapped = decodeWithObfuscationMap(player.obfuscationKey, player.rawName);
      if (isPersonLikeName(mapped)) {
        player.decodedName = mapped;
      }
    }

    for (let index = 0; index < players.length; index += 1) {
      const player = players[index];
      if (isPersonLikeName(player.decodedName)) continue;
      if (String(player.rawName).trim().toLowerCase() === "k.a.") continue;

      const nameHandle = await playerHandles[index].$(".player-name");
      player.decodedName = await readNameWithOcr(nameHandle, player.number);
    }

    return {
      ok: true,
      matchId,
      url,
      home,
      away,
      ownSide,
      count: players.length,
      players: players
        .filter((player) => {
          const raw = String(player.rawName || "").trim().toLowerCase();
          const number = String(player.number || "").trim();

          if (raw === "k.a.") return false;
          if (!number && !isPersonLikeName(player.decodedName)) return false;

          return true;
        })
        .map((player) => ({
          id: player.id,
          matchId,
          side: player.side,
          name: buildDisplayName(player.decodedName, player.number),
          rawName: player.rawName,
          number: player.number,
          img: player.img,
          obfuscationKey: player.obfuscationKey
        }))
    };
  } finally {
    await page.close();
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/matches", async (_req, res) => {
  try {
    const [{ games: currentGames, votingWindow }, { games: historyWeekGames }] = await Promise.all([
      loadWeekGamesData({ includeUnresolved: true }),
      loadHistoryWeekGamesData().catch(() => ({ games: [] }))
    ]);
    const games = mergeGames([...historyWeekGames, ...currentGames]);
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      votingWindow,
      count: games.length,
      games
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      games: []
    });
  }
});

app.get("/matches-lite", async (_req, res) => {
  try {
    const { games, votingWindow } = await loadCachedMatchesLiteData();
    res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      votingWindow,
      count: games.length,
      games
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      games: []
    });
  }
});

app.get("/debug-score", async (req, res) => {
  const matchId = String(req.query.matchId || req.query.spielId || "").trim();
  const home = String(req.query.home || "").trim();
  const away = String(req.query.away || "").trim();

  if (!matchId || !home || !away) {
    res.status(400).json({
      ok: false,
      error: "missing_match_parameters",
      required: ["matchId", "home", "away"]
    });
    return;
  }

  try {
    const details = await inspectRenderedMatchScore({ matchId, home, away });
    res.json({
      ok: true,
      ...details
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      matchId,
      home,
      away
    });
  }
});

app.get("/team-schedule", async (req, res) => {
  const teamId = String(req.query.teamId || "").trim();
  const label = String(req.query.label || "").trim();
  const clubName = String(req.query.club || CLUB_NAME).trim() || CLUB_NAME;
  const force = String(req.query.force || "").trim() === "1";
  const includePast = String(req.query.includePast || "").trim() === "1";
  const cacheKey = `${teamId}|${label}|${clubName}|${includePast ? "past" : "upcoming"}`;

  if (!teamId) {
    res.status(400).json({
      ok: false,
      error: "missing_team_id",
      matches: []
    });
    return;
  }

  try {
    const cacheEntry = TEAM_SCHEDULE_CACHE.get(cacheKey);
    const isFresh = cacheEntry && Date.now() - cacheEntry.loadedAt < TEAM_SCHEDULE_TTL_MS;
    if (!force && isFresh) {
      res.json(cacheEntry.payload);
      return;
    }

    let matches = [];

    if (includePast) {
      const matchplanHtml = await fetchFullSeasonTeamMatchplanHtml(teamId, { force });
      matches = extractUpcomingMatchesFromMatchplanHtml(matchplanHtml, {
        teamId,
        label,
        clubName,
        includePast: true
      });
      matches = await hydratePastMatchResults(matches);
    } else {
      const html = await fetchTeamNextGamesHtml(teamId, { force });
      matches = extractUpcomingMatchesFromNextGamesHtml(html, { teamId, label, clubName });

      if (!matches.length) {
        const matchplanHtml = await fetchTeamMatchplanHtml(teamId);
        matches = extractUpcomingMatchesFromMatchplanHtml(matchplanHtml, { teamId, label, clubName });
      }
    }

    const payload = {
      ok: true,
      generatedAt: new Date().toISOString(),
      teamId,
      label,
      clubName,
      includePast,
      count: matches.length,
      matches
    };

    TEAM_SCHEDULE_CACHE.set(cacheKey, {
      loadedAt: Date.now(),
      payload
    });

    res.json(payload);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      teamId,
      label,
      matches: []
    });
  }
});

app.get("/lineup", async (req, res) => {
  let matchId = String(req.query.matchId || "").trim();
  const home = String(req.query.home || "").trim();
  const away = String(req.query.away || "").trim();
  const date = String(req.query.date || "").trim();
  const time = String(req.query.time || "").trim();
  const competition = String(req.query.competition || "").trim();

  if (!home || !away) {
    res.status(400).json({
      ok: false,
      error: "missing_home_away",
      players: []
    });
    return;
  }

  try {
    let resolvedMatch = null;

    if (!matchId) {
      resolvedMatch = await resolveMatchFromTeamPages({ home, away, date, time, competition });
      matchId = String(resolvedMatch?.matchId || "").trim();
    }

    if (!matchId) {
      res.status(404).json({
        ok: false,
        error: "match_id_not_found",
        home,
        away,
        players: []
      });
      return;
    }

    const result = await scrapeLineup({ matchId, home, away });
    res.json(
      resolvedMatch
        ? {
            ...result,
            resolvedBy: "team_matchplan"
          }
        : result
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isLineupUnavailable =
      message.includes("Waiting for selector `.player-wrapper.home, .player-wrapper.away` failed") ||
      message.includes("lineup_not_available");

    if (isLineupUnavailable) {
      res.json({
        ok: false,
        error: "lineup_not_available",
        message,
        matchId,
        home,
        away,
        players: []
      });
      return;
    }

    res.status(500).json({
      ok: false,
      error: message,
      players: []
    });
  }
});

app.get("/train-week", async (_req, res) => {
  try {
    const games = await loadWeekGames();
    const results = [];

    for (const game of games) {
      const before = getMappingStats();
      const result = await scrapeLineup({
        matchId: String(game.spielId).trim(),
        home: String(game.home || "").trim(),
        away: String(game.away || "").trim()
      });
      const after = getMappingStats();

      results.push({
        matchId: result.matchId,
        home: result.home,
        away: result.away,
        players: result.count,
        learnedChars: after.totalChars - before.totalChars
      });
    }

    res.json({
      ok: true,
      trainedMatches: results.length,
      mapping: getMappingStats(),
      results
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

loadObfuscationMaps();

app.listen(PORT, () => {
  console.log(`MOTM scraper listening on http://localhost:${PORT}`);
});
