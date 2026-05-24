/**
 * coinportal/src/indexer.ts
 *
 * Multi-Bot Autonomous AI Trading Engine
 * — 4 independent bots with staggered intervals
 * — Mutex-guarded async wallet I/O (no corruption under concurrent writes)
 * — JSON-only Ollama prompt (no conversational refusals)
 * — File-backed wallet.json + embedded HTTP API on :3001
 *
 * Compile:        npx tsc
 * Run (ts-node):  npx ts-node src/indexer.ts
 * Run (compiled): node dist/indexer.js
 *
 * Env overrides:
 *   OLLAMA_URL   — default http://localhost:11434/api/generate
 *   OLLAMA_MODEL — default llama3.2
 *   BUY_SOL      — SOL per trade, default 1
 *   MAX_RISK      — AI veto threshold (score > MAX_RISK = blocked), default 40
 *   MA_PERIODS   — moving-average window, default 5
 *   API_PORT     — HTTP API port, default 3001
 *   WALLET_PATH  — path to wallet.json, default ./wallet.json
 */

import fs   from "fs";
import fsp  from "fs/promises";
import path from "path";
import http from "http";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_URL     = process.env.OLLAMA_URL    ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   ?? "llama3.2";
const OLLAMA_TIMEOUT = 30_000;
const BUY_SOL        = parseFloat(process.env.BUY_SOL    ?? "1");
const MAX_RISK       = parseInt(process.env.MAX_RISK      ?? "40",   10);
const MA_PERIODS     = parseInt(process.env.MA_PERIODS    ?? "5",    10);
const API_PORT       = parseInt(process.env.API_PORT      ?? "3001", 10);
const WALLET_PATH    = path.resolve(process.env.WALLET_PATH ?? "./wallet.json");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface WalletPosition {
  coinId:        string;
  symbol:        string;
  name:          string;
  buyPrice:      number;
  amount:        number;
  totalSpentSol: number;
  boughtAt:      string;
  riskScore:     number;
  mintAddress:   string;
  botName:       string;  // which bot executed the trade
}

interface TradeEvent {
  id:              number;
  botName:         string;
  symbol:          string;
  name:            string;
  mintAddress:     string;
  action:          "BUY" | "BLOCKED";
  reason?:         string;
  solSpent?:       number;
  tokensReceived?: number;
  price?:          number;
  riskScore?:      number;
  timestamp:       string;
}

interface WalletState {
  solBalance:  number;
  startingSOL: number;
  tradeCount:  number;
  positions:   WalletPosition[];
  tradeLog:    TradeEvent[];
  lastUpdated: string;
}

interface TokenData {
  name:           string;
  symbol:         string;
  mintAddress:    string;
  totalSupply:    number;
  decimals:       number;
  creatorAddress: string;
  holders?:       number;
  liquidityUsd?:  number;
  ageHours?:      number;
  currentPrice?:  number;
  metadata?:      Record<string, unknown>;
}

interface SecurityProfile {
  mintAuthorityDisabled: boolean;
  liquidityLocked:       boolean;
}

interface OllamaResponse {
  model:      string;
  created_at: string;
  response:   string;
  done:       boolean;
}

interface TokenRiskAnalysis {
  riskScore:  number | null;
  raw:        string;
  model:      string;
  analyzedAt: string;
}

type PipelineResult =
  | { passed: true;  riskScore: number; maAvg: number; price: number }
  | { passed: false; reason: string };

interface BotConfig {
  name:       string;   // "Alpha" | "Beta" | "Gamma" | "Delta"
  label:      string;   // "[Bot Alpha]"
  intervalMs: number;   // staggered tick speed
  delayMs:    number;   // startup delay so bots don't all fire at t=0
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot Configurations — staggered intervals + startup delays
// ─────────────────────────────────────────────────────────────────────────────

const BOT_CONFIGS: BotConfig[] = [
  { name: "Alpha", label: "[Bot Alpha]", intervalMs: 10_000, delayMs:  0    },
  { name: "Beta",  label: "[Bot Beta]",  intervalMs: 12_000, delayMs:  3_000 },
  { name: "Gamma", label: "[Bot Gamma]", intervalMs: 13_500, delayMs:  6_500 },
  { name: "Delta", label: "[Bot Delta]", intervalMs: 15_000, delayMs:  9_000 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "TRADE" | "FILTER";

// ANSI colour codes — gracefully stripped if stdout is not a TTY
const isTTY   = process.stdout.isTTY;
const COL: Record<string, string> = {
  reset:  isTTY ? "\x1b[0m"  : "",
  bold:   isTTY ? "\x1b[1m"  : "",
  dim:    isTTY ? "\x1b[2m"  : "",
  red:    isTTY ? "\x1b[31m" : "",
  green:  isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  cyan:   isTTY ? "\x1b[36m" : "",
  grey:   isTTY ? "\x1b[90m" : "",
};

// Per-bot colours so streams are easy to visually separate in the terminal
const BOT_COLOURS: Record<string, string> = {
  Alpha: isTTY ? "\x1b[36m" : "",   // cyan
  Beta:  isTTY ? "\x1b[35m" : "",   // magenta
  Gamma: isTTY ? "\x1b[33m" : "",   // yellow
  Delta: isTTY ? "\x1b[34m" : "",   // blue
};

function log(level: LogLevel, botName: string, msg: string): void {
  const ts       = new Date().toISOString();
  const lvlPad   = level.padEnd(6);
  const botCol   = BOT_COLOURS[botName] ?? "";
  const lvlStr   =
    level === "ERROR" ? `${COL.red}${lvlPad}${COL.reset}`
    : level === "TRADE"  ? `${COL.green}${COL.bold}${lvlPad}${COL.reset}`
    : level === "FILTER" ? `${COL.cyan}${lvlPad}${COL.reset}`
    : level === "WARN"   ? `${COL.yellow}${lvlPad}${COL.reset}`
    :                      `${COL.dim}${lvlPad}${COL.reset}`;
  const botStr   = `${botCol}[Bot ${botName.padEnd(5)}]${COL.reset}`;
  const line     = `${COL.grey}[${ts}]${COL.reset} [${lvlStr}] ${botStr} ${msg}`;
  level === "ERROR" ? console.error(line) : console.log(line);
}

function banner(msg: string): void {
  const border = "█".repeat(62);
  console.log(`\n${COL.green}${border}${COL.reset}`);
  msg.split("\n").forEach(l => console.log(`  ${COL.bold}${l}${COL.reset}`));
  console.log(`${COL.green}${border}${COL.reset}\n`);
}

function startupBanner(): void {
  const border = "=".repeat(62);
  console.log(`\n${COL.cyan}${border}${COL.reset}`);
  console.log(`  ${COL.bold}${COL.cyan}CoinPortal Multi-Bot Autonomous Trading Engine${COL.reset}`);
  console.log(`  Wallet  : ${WALLET_PATH}`);
  console.log(`  API     : http://127.0.0.1:${API_PORT}/api/wallet`);
  console.log(`  Ollama  : ${OLLAMA_URL}  (model: ${OLLAMA_MODEL})`);
  console.log(`  Buy     : ${BUY_SOL} SOL/trade  |  Max risk: ${MAX_RISK}  |  MA: ${MA_PERIODS}p`);
  console.log(`\n  Bots:`);
  for (const b of BOT_CONFIGS) {
    const col = BOT_COLOURS[b.name] ?? "";
    console.log(`    ${col}● ${b.label.padEnd(14)}${COL.reset}  tick every ${b.intervalMs / 1000}s  |  start +${b.delayMs / 1000}s`);
  }
  console.log(`${COL.cyan}${border}${COL.reset}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Mutex — prevents simultaneous wallet writes from multiple bots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A simple promise-chain mutex.  Any code that needs exclusive wallet access
 * calls `walletMutex.run(async () => { ... })`.  Concurrent callers queue up
 * and execute strictly one at a time, preserving serialisability without the
 * need for an external locking library.
 */
class AsyncMutex {
  private _queue: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain the new task onto the tail of the queue, capturing the result via
    // an outer promise so callers can await the real return value.
    let resolve!: (v: T) => void;
    let reject!:  (e: unknown) => void;
    const outer = new Promise<T>((res, rej) => { resolve = res; reject = rej; });

    this._queue = this._queue.then(async () => {
      try   { resolve(await fn()); }
      catch (e) { reject(e); }
    });

    return outer;
  }
}

const walletMutex = new AsyncMutex();

// ─────────────────────────────────────────────────────────────────────────────
// Async File-backed Wallet Store
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_WALLET: WalletState = {
  solBalance:  100,
  startingSOL: 100,
  tradeCount:  0,
  positions:   [],
  tradeLog:    [],
  lastUpdated: new Date().toISOString(),
};

/** Read wallet.json asynchronously, creating it if absent. */
async function loadWallet(): Promise<WalletState> {
  try {
    const raw    = await fsp.readFile(WALLET_PATH, "utf8");
    const parsed = JSON.parse(raw) as WalletState;
    log("INFO", "SYSTEM", `Wallet loaded — ${parsed.solBalance} SOL, ${parsed.positions.length} position(s)`);
    return parsed;
  } catch {
    log("INFO", "SYSTEM", `No existing wallet found — creating ${WALLET_PATH} with 100 SOL`);
    await saveWalletRaw({ ...INITIAL_WALLET });
    return { ...INITIAL_WALLET, positions: [], tradeLog: [] };
  }
}

/**
 * Async atomic write: write to a .tmp file then rename.
 * Rename is atomic on POSIX (macOS/Linux), so a mid-crash never produces
 * a partial wallet.json.
 */
async function saveWalletRaw(state: WalletState): Promise<void> {
  state.lastUpdated = new Date().toISOString();
  const tmp = `${WALLET_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, WALLET_PATH);
}

/**
 * PUBLIC: always call this through the mutex so concurrent bots never
 * interleave their reads and writes.
 *
 * Pattern for every wallet mutation:
 *   await walletMutex.run(async () => {
 *     const w = await readWalletFromDisk();
 *     // … mutate w …
 *     await saveWalletRaw(w);
 *     memWallet = w;   // keep in-memory cache in sync
 *   });
 */
async function readWalletFromDisk(): Promise<WalletState> {
  const raw = await fsp.readFile(WALLET_PATH, "utf8");
  return JSON.parse(raw) as WalletState;
}

// In-memory cache — always reflects the last committed wallet state and is
// used only for read-only queries (API server, log lines) to avoid hitting
// disk on every /api/wallet poll.
let memWallet: WalletState = { ...INITIAL_WALLET, positions: [], tradeLog: [] };

// ─────────────────────────────────────────────────────────────────────────────
// Wallet mutations (all mutex-guarded)
// ─────────────────────────────────────────────────────────────────────────────

async function executeBuy(
  botName:   string,
  token:     TokenData & { currentPrice: number },
  riskScore: number,
  amountSol: number,
): Promise<number> {
  return walletMutex.run(async () => {
    // Always re-read from disk inside the mutex so we see writes from other bots
    const w = await readWalletFromDisk();

    if (amountSol > w.solBalance)
      throw new Error(`Insufficient SOL (have ${w.solBalance.toFixed(4)}, need ${amountSol})`);

    const tokensReceived = amountSol / token.currentPrice;
    w.solBalance         = parseFloat((w.solBalance - amountSol).toFixed(6));
    w.tradeCount++;

    const existing = w.positions.find(p => p.mintAddress === token.mintAddress);
    if (existing) {
      existing.amount        += tokensReceived;
      existing.totalSpentSol += amountSol;
    } else {
      w.positions.push({
        coinId:        token.mintAddress,
        symbol:        token.symbol,
        name:          token.name,
        buyPrice:      token.currentPrice,
        amount:        tokensReceived,
        totalSpentSol: amountSol,
        boughtAt:      new Date().toISOString(),
        riskScore,
        mintAddress:   token.mintAddress,
        botName,
      });
    }

    w.tradeLog.unshift({
      id:             w.tradeCount,
      botName,
      symbol:         token.symbol,
      name:           token.name,
      mintAddress:    token.mintAddress,
      action:         "BUY",
      solSpent:       amountSol,
      tokensReceived,
      price:          token.currentPrice,
      riskScore,
      timestamp:      new Date().toISOString(),
    });
    if (w.tradeLog.length > 200) w.tradeLog.length = 200;

    await saveWalletRaw(w);
    memWallet = w;   // update cache
    return tokensReceived;
  });
}

async function appendBlockedEvent(
  botName: string,
  token:   TokenData,
  reason:  string,
): Promise<void> {
  await walletMutex.run(async () => {
    const w = await readWalletFromDisk();
    w.tradeLog.unshift({
      id:          w.tradeCount,
      botName,
      symbol:      token.symbol,
      name:        token.name,
      mintAddress: token.mintAddress,
      action:      "BLOCKED",
      reason,
      timestamp:   new Date().toISOString(),
    });
    if (w.tradeLog.length > 200) w.tradeLog.length = 200;
    await saveWalletRaw(w);
    memWallet = w;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP API Server (read-only, no mutex needed)
// ─────────────────────────────────────────────────────────────────────────────

function startApiServer(): void {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url?.split("?")[0];

    if (url === "/api/wallet") {
      // Serve the in-memory cache — always consistent with last commit
      res.writeHead(200);
      res.end(JSON.stringify(memWallet));
      return;
    }

    if (url === "/api/health") {
      res.writeHead(200);
      res.end(JSON.stringify({
        status:  "ok",
        uptime:  process.uptime(),
        bots:    BOT_CONFIGS.map(b => b.name),
        balance: memWallet.solBalance,
        trades:  memWallet.tradeCount,
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(API_PORT, "127.0.0.1", () => {
    log("INFO", "SYSTEM", `API listening on http://127.0.0.1:${API_PORT}`);
  });

  server.on("error", err => log("ERROR", "SYSTEM", `API error: ${err.message}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Token Pool
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_TOKENS: TokenData[] = [
  { name: "Baby Doge Coin",   symbol: "BABYDOGE",  mintAddress: "BabyD0geXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 420_000_000_000_000, decimals: 9, creatorAddress: "Creator1XXX", holders: 142_000, liquidityUsd: 3_200_000, ageHours: 720   },
  { name: "SketchyMoon",      symbol: "SKMN",      mintAddress: "SketchyMoon1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000,   decimals: 9, creatorAddress: "Creator2XXX", holders: 7,       liquidityUsd: 180,       ageHours: 0.5  },
  { name: "Floki Inu",        symbol: "FLOKI",     mintAddress: "Fl0k1InuXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 10_000_000_000_000,  decimals: 9, creatorAddress: "Creator3XXX", holders: 89_000,  liquidityUsd: 920_000,   ageHours: 2160 },
  { name: "AquaGoat Finance", symbol: "AQUAGOAT",  mintAddress: "AquaGoatXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 100_000_000_000,     decimals: 9, creatorAddress: "Creator4XXX", holders: 3,       liquidityUsd: 62,        ageHours: 1,   metadata: { website: null } },
  { name: "EverGrow Coin",    symbol: "EGC",       mintAddress: "EverGrowXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000_000, decimals: 9, creatorAddress: "Creator5XXX", holders: 54_000, liquidityUsd: 450_000,   ageHours: 4320 },
  { name: "SafeMoon",         symbol: "SFM",       mintAddress: "SafeM00nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000,   decimals: 9, creatorAddress: "Creator6XXX", holders: 31_000,  liquidityUsd: 210_000,   ageHours: 960  },
];

// Per-symbol price histories — shared across bots (reads are safe; no mutex
// needed because JS is single-threaded and these are only written inside each
// bot's async tick, which never overlaps on the same symbol simultaneously).
const priceHistories: Record<string, number[]> = {};

function getOrInitPriceHistory(symbol: string, basePrice: number): number[] {
  if (!priceHistories[symbol]) {
    priceHistories[symbol] = Array.from({ length: MA_PERIODS }, () =>
      basePrice * (0.85 + Math.random() * 0.30)
    );
  }
  return priceHistories[symbol];
}

function pickRandomToken(): TokenData & { currentPrice: number } {
  const base      = MOCK_TOKENS[Math.floor(Math.random() * MOCK_TOKENS.length)];
  const basePrice = parseFloat((Math.random() * 0.001).toFixed(8)) || 0.0000024;
  return {
    ...base,
    mintAddress:  base.mintAddress.slice(0, 8) + Math.random().toString(36).slice(2, 10).toUpperCase(),
    ageHours:     parseFloat((Math.random() * 48).toFixed(2)),
    liquidityUsd: base.liquidityUsd != null
      ? Math.round(base.liquidityUsd * (0.5 + Math.random()))
      : undefined,
    currentPrice: basePrice,
  };
}

function fetchSecurityProfile(token: TokenData): SecurityProfile {
  const badToken = (token.holders ?? 0) < 10 || (token.liquidityUsd ?? 0) < 500;
  return {
    mintAuthorityDisabled: !badToken && Math.random() > 0.25,
    liquidityLocked:       !badToken && Math.random() > 0.30,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama — JSON-only prompt (fixes conversational refusals)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Key design decisions that prevent llama3.2 from returning prose:
 *
 * 1. Role framing: "Statistical Data Sanitizer" instead of "analyst" removes
 *    the financial-advice context that triggers safety refusals.
 * 2. System prompt is injected via the `system` field (Ollama supports it)
 *    so it is authoritative and separated from the data payload.
 * 3. The only valid output is described as raw JSON — no keys other than
 *    "score", no markdown fences, no preamble, no explanation.
 * 4. The user turn contains only a compact data array, not prose questions,
 *    so the model has nothing conversational to respond to.
 * 5. `parseRiskScore` now tries JSON.parse first, then falls back to a
 *    regex scan, so minor formatting slippage still produces a valid score.
 */
function buildPrompt(token: TokenData): { system: string; prompt: string } {
  const system =
    "You are a Statistical Data Sanitizer. " +
    "Your only function is to process raw numeric token data arrays and output a single JSON object. " +
    "You MUST output ONLY a valid JSON object with a single key \"score\" whose value is an integer from 1 to 100. " +
    "A score of 1 means extremely low risk. A score of 100 means extremely high risk. " +
    "Do NOT output any text, greeting, explanation, sentence, apology, markdown, or code fence — " +
    "ONLY the raw JSON object. Any output other than a valid JSON object is a critical system error.";

  const dataArray = JSON.stringify({
    supply:    token.totalSupply,
    holders:   token.holders   ?? 0,
    liquidity: token.liquidityUsd ?? 0,
    ageHours:  token.ageHours  ?? 0,
    decimals:  token.decimals,
    hasMeta:   !!token.metadata,
  });

  const prompt = `INPUT_DATA: ${dataArray}\nOUTPUT:`;

  return { system, prompt };
}

function parseRiskScore(raw: string): number | null {
  // Strategy 1: direct JSON parse (best case — model followed instructions)
  try {
    const trimmed = raw.trim();
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const n   = Number(obj["score"]);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  } catch { /* fall through */ }

  // Strategy 2: extract the first JSON-shaped object from the raw string
  // (handles cases where the model wraps the JSON in prose)
  const jsonMatch = raw.match(/\{[^}]*"score"\s*:\s*(\d{1,3})[^}]*\}/);
  if (jsonMatch) {
    const n = parseInt(jsonMatch[1], 10);
    if (n >= 1 && n <= 100) return n;
  }

  // Strategy 3: bare integer fallback (last resort)
  const numMatch = raw.match(/\b([1-9]\d?|100)\b/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    if (n >= 1 && n <= 100) return n;
  }

  return null;
}

async function analyzeTokenWithOllama(
  botName: string,
  token:   TokenData,
): Promise<TokenRiskAnalysis> {
  const { system, prompt } = buildPrompt(token);
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);

  let response: Response;
  try {
    response = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        model:  OLLAMA_MODEL,
        system,          // keeps role instructions out of the user turn
        prompt,
        stream: false,
        options: {
          temperature: 0,      // deterministic output = more reliable JSON
          top_p: 1,
          num_predict: 20,     // score only needs ~10 tokens; cap prevents rambling
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama unreachable — ${msg}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(`Ollama HTTP ${response.status}: ${text}`);
  }

  const json      = (await response.json()) as OllamaResponse;
  const riskScore = parseRiskScore(json.response);

  if (riskScore === null) {
    log("WARN", botName, `Ollama raw response (failed to parse): "${json.response.slice(0, 80)}"`);
  }

  return {
    riskScore,
    raw:        json.response,
    model:      json.model,
    analyzedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4-Step Verification Pipeline (per-bot, bot name threaded through)
// ─────────────────────────────────────────────────────────────────────────────

async function processAutonomousTradeFlow(
  bot:   BotConfig,
  token: TokenData & { currentPrice: number },
): Promise<PipelineResult> {
  const { name: botName, label } = bot;
  const tag = `${label} [${token.symbol}]`;

  // ── Filter 1 · Metadata ────────────────────────────────────────────────────
  log("FILTER", botName, `${tag} Filter 1 — Metadata`);
  const missingName   = !token.name?.trim();
  const missingSymbol = !token.symbol?.trim();
  const tooFewHolders = (token.holders ?? 0) <= 10;
  if (missingName || missingSymbol || tooFewHolders) {
    const reason = [
      missingName   && "missing name",
      missingSymbol && "missing symbol",
      tooFewHolders && `holders ≤ 10 (${token.holders ?? 0})`,
    ].filter(Boolean).join(", ");
    log("FILTER", botName, `${tag} ✗ F1 FAILED — ${reason}`);
    return { passed: false, reason: `Metadata: ${reason}` };
  }
  log("FILTER", botName, `${tag} ✓ F1 passed — holders: ${token.holders}`);

  // ── Filter 2 · Security ────────────────────────────────────────────────────
  log("FILTER", botName, `${tag} Filter 2 — Security`);
  const sec = fetchSecurityProfile(token);
  if (!sec.mintAuthorityDisabled || !sec.liquidityLocked) {
    const reason = [
      !sec.mintAuthorityDisabled && "mint authority active",
      !sec.liquidityLocked       && "liquidity unlocked",
    ].filter(Boolean).join(", ");
    log("FILTER", botName, `${tag} ✗ F2 FAILED — ${reason}`);
    return { passed: false, reason: `Security: ${reason}` };
  }
  log("FILTER", botName, `${tag} ✓ F2 passed — mint disabled & liq locked`);

  // ── Filter 3 · Ollama AI (JSON-only prompt) ────────────────────────────────
  log("FILTER", botName, `${tag} Filter 3 — Ollama AI`);
  let analysis: TokenRiskAnalysis;
  try {
    analysis = await analyzeTokenWithOllama(botName, token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("WARN", botName, `${tag} ⚠ Ollama unavailable — soft-blocking (${msg})`);
    return { passed: false, reason: `Ollama error: ${msg}` };
  }

  const { riskScore } = analysis;
  if (riskScore === null) {
    log("WARN", botName, `${tag} ⚠ Score parse failed — vetoing`);
    return { passed: false, reason: "AI: parse failure" };
  }
  if (riskScore > MAX_RISK) {
    log("FILTER", botName, `${tag} ❌ AI Vetoed: Risk Score Too High (${riskScore} > ${MAX_RISK})`);
    return { passed: false, reason: `AI veto: score ${riskScore} > ${MAX_RISK}` };
  }
  log("FILTER", botName, `${tag} 🟢 Filter 3 Passed — score ${riskScore}/100 ≤ ${MAX_RISK}`);

  // ── Filter 4 · Moving Average ──────────────────────────────────────────────
  log("FILTER", botName, `${tag} Filter 4 — ${MA_PERIODS}-period MA`);
  const history = getOrInitPriceHistory(token.symbol, token.currentPrice);
  const window  = history.slice(-MA_PERIODS);
  const maAvg   = window.reduce((s, p) => s + p, 0) / window.length;
  const price   = token.currentPrice;
  history.push(price);
  if (history.length > MA_PERIODS * 6) history.splice(0, 1);

  if (price <= maAvg) {
    log("FILTER", botName, `${tag} ✗ F4 FAILED — ${price.toFixed(8)} ≤ avg ${maAvg.toFixed(8)}`);
    return { passed: false, reason: `MA: price below ${MA_PERIODS}-period avg` };
  }
  log("FILTER", botName, `${tag} ✓ F4 passed — ${price.toFixed(8)} > avg ${maAvg.toFixed(8)}`);

  return { passed: true, riskScore, maAvg, price };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-Bot Trading Cycle
// ─────────────────────────────────────────────────────────────────────────────

const botCycleCounts: Record<string, number> = {};

async function runBotCycle(bot: BotConfig): Promise<void> {
  botCycleCounts[bot.name] = (botCycleCounts[bot.name] ?? 0) + 1;
  const cycleNum = botCycleCounts[bot.name];
  const token    = pickRandomToken();

  log("INFO", bot.name,
    `─── Cycle #${cycleNum} | ${token.name} (${token.symbol}) @ ${token.currentPrice.toFixed(8)} SOL ` +
    `| holders: ${token.holders ?? "?"} | liq: $${token.liquidityUsd?.toLocaleString() ?? "?"}`
  );

  const result = await processAutonomousTradeFlow(bot, token);

  if (!result.passed) {
    log("INFO", bot.name, `  ⛔ Blocked — ${result.reason}`);
    // Fire-and-forget the blocked event write; no need to await in the hot path
    appendBlockedEvent(bot.name, token, result.reason).catch(err =>
      log("WARN", bot.name, `Failed to log blocked event: ${(err as Error).message}`)
    );
    return;
  }

  // All 4 filters cleared — execute buy through the mutex-guarded function
  let tokensAcquired: number;
  try {
    tokensAcquired = await executeBuy(bot.name, token, result.riskScore, BUY_SOL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("WARN", bot.name, `  ⚠ Buy failed — ${msg}`);
    await appendBlockedEvent(bot.name, token, `Buy failed: ${msg}`);
    return;
  }

  // Read fresh balance from cache (executeBuy already updated memWallet)
  const allocation = ((BUY_SOL / (memWallet.solBalance + BUY_SOL)) * 100).toFixed(2);

  banner(
    `🚀 TRADE #${memWallet.tradeCount} — ${bot.label}\n` +
    `   Token    : ${token.name} (${token.symbol})\n` +
    `   Mint     : ${token.mintAddress}\n` +
    `   Price    : ${result.price.toFixed(8)} SOL  |  Spent: ${BUY_SOL} SOL\n` +
    `   Received : ${tokensAcquired.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens\n` +
    `   AI score : ${result.riskScore}/100 ✓   MA signal: above avg ✓\n` +
    `   Balance  : ${memWallet.solBalance.toFixed(4)} SOL remaining  (${allocation}% deployed)\n` +
    `   Positions: ${memWallet.positions.length} open`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot Spawner — wraps each cycle in a top-level catch so one bot crash never
// kills the others or the main process (launchd keeps running either way)
// ─────────────────────────────────────────────────────────────────────────────

function spawnBot(bot: BotConfig): void {
  const safeTick = async () => {
    try {
      await runBotCycle(bot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("ERROR", bot.name, `Unhandled error in cycle: ${msg}`);
      log("WARN",  bot.name, `Bot continuing — next tick in ${bot.intervalMs / 1000}s`);
    }
  };

  // Startup delay so bots don't all slam Ollama at t=0
  setTimeout(() => {
    log("INFO", bot.name, `${bot.label} starting — interval: ${bot.intervalMs / 1000}s`);
    safeTick();                            // fire immediately after delay
    setInterval(safeTick, bot.intervalMs); // then on schedule
  }, bot.delayMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  // Load or create wallet.json before any bot or server starts
  memWallet = await loadWallet();

  startupBanner();
  startApiServer();

  // Spawn all 4 bots — each runs its own independent setInterval
  for (const bot of BOT_CONFIGS) spawnBot(bot);

  process.on("SIGTERM", async () => {
    log("INFO", "SYSTEM", "SIGTERM received — flushing wallet and exiting");
    await saveWalletRaw(memWallet);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    log("INFO", "SYSTEM", "SIGINT received — flushing wallet and exiting");
    await saveWalletRaw(memWallet);
    process.exit(0);
  });
})();
