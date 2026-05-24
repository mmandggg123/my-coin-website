/**
 * coinportal/src/indexer.ts
 *
 * Autonomous AI Trading Agent — file-persisted wallet + Express API.
 *
 * Compile:        npx tsc
 * Run (ts-node):  npx ts-node src/indexer.ts
 * Run (compiled): node dist/indexer.js
 *
 * Env overrides:
 *   OLLAMA_URL    — default http://localhost:11434/api/generate
 *   OLLAMA_MODEL  — default llama3.2
 *   INTERVAL_MS   — default 30000
 *   BUY_SOL       — SOL per trade, default 1
 *   MAX_RISK      — AI veto threshold, default 40
 *   MA_PERIODS    — moving-average window, default 5
 *   API_PORT      — local API port, default 3001
 *   WALLET_PATH   — path to wallet.json, default ./wallet.json
 */

import fs   from "fs";
import path from "path";
import http from "http";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_URL     = process.env.OLLAMA_URL    ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   ?? "llama3.2";
const OLLAMA_TIMEOUT = 30_000;
const INTERVAL_MS    = parseInt(process.env.INTERVAL_MS  ?? "30000", 10);
const BUY_SOL        = parseFloat(process.env.BUY_SOL    ?? "1");
const MAX_RISK       = parseInt(process.env.MAX_RISK      ?? "40",    10);
const MA_PERIODS     = parseInt(process.env.MA_PERIODS    ?? "5",     10);
const API_PORT       = parseInt(process.env.API_PORT      ?? "3001",  10);
const WALLET_PATH    = path.resolve(process.env.WALLET_PATH ?? "./wallet.json");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface WalletPosition {
  coinId:         string;
  symbol:         string;
  name:           string;
  buyPrice:       number;
  amount:         number;
  totalSpentSol:  number;
  boughtAt:       string;   // ISO timestamp
  riskScore:      number;
  mintAddress:    string;
}

interface TradeEvent {
  id:             number;
  symbol:         string;
  name:           string;
  mintAddress:    string;
  action:         "BUY" | "BLOCKED";
  reason?:        string;
  solSpent?:      number;
  tokensReceived?: number;
  price?:         number;
  riskScore?:     number;
  timestamp:      string;
}

interface WalletState {
  solBalance:   number;
  startingSOL:  number;
  tradeCount:   number;
  positions:    WalletPosition[];
  tradeLog:     TradeEvent[];
  lastUpdated:  string;
}

interface TokenData {
  name:          string;
  symbol:        string;
  mintAddress:   string;
  totalSupply:   number;
  decimals:      number;
  creatorAddress: string;
  holders?:      number;
  liquidityUsd?: number;
  ageHours?:     number;
  currentPrice?: number;
  metadata?:     Record<string, unknown>;
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
  raw:        string;
  riskScore:  number | null;
  model:      string;
  analyzedAt: string;
}

type PipelineResult =
  | { passed: true;  riskScore: number; maAvg: number; price: number }
  | { passed: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "TRADE" | "FILTER";

function log(level: LogLevel, msg: string): void {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level.padEnd(6)}] ${msg}`;
  level === "ERROR" ? console.error(line) : console.log(line);
}

function banner(char: string, msg: string): void {
  const border = char.repeat(60);
  console.log(`\n${border}\n  ${msg}\n${border}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// File-backed Wallet Store
// ─────────────────────────────────────────────────────────────────────────────

const INITIAL_WALLET: WalletState = {
  solBalance:  100,
  startingSOL: 100,
  tradeCount:  0,
  positions:   [],
  tradeLog:    [],
  lastUpdated: new Date().toISOString(),
};

/** Read wallet.json from disk, or create it with defaults on first run. */
function loadWallet(): WalletState {
  try {
    if (fs.existsSync(WALLET_PATH)) {
      const raw = fs.readFileSync(WALLET_PATH, "utf8");
      const parsed = JSON.parse(raw) as WalletState;
      log("INFO", `Wallet loaded from ${WALLET_PATH} — balance: ${parsed.solBalance} SOL, ${parsed.positions.length} position(s)`);
      return parsed;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("WARN", `Could not read wallet.json (${msg}) — initialising fresh wallet`);
  }

  log("INFO", `Creating new wallet at ${WALLET_PATH} with ${INITIAL_WALLET.solBalance} SOL`);
  saveWallet(INITIAL_WALLET);
  return { ...INITIAL_WALLET, tradeLog: [], positions: [] };
}

/** Atomically write wallet state to disk via a temp file + rename. */
function saveWallet(state: WalletState): void {
  state.lastUpdated = new Date().toISOString();
  const tmp = `${WALLET_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, WALLET_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Failed to persist wallet: ${msg}`);
  }
}

// In-memory wallet (kept in sync with disk after every mutation)
let wallet: WalletState = loadWallet();

/** Buy tokens — mutates wallet in memory and flushes to disk. */
function executeBuy(
  token:    TokenData & { currentPrice: number },
  riskScore: number,
  amountSol: number,
): number {
  if (amountSol > wallet.solBalance)
    throw new Error(`Insufficient SOL (have ${wallet.solBalance.toFixed(4)}, need ${amountSol})`);

  const tokensReceived = amountSol / token.currentPrice;
  wallet.solBalance    = parseFloat((wallet.solBalance - amountSol).toFixed(6));
  wallet.tradeCount++;

  const existing = wallet.positions.find(p => p.mintAddress === token.mintAddress);
  if (existing) {
    existing.amount       += tokensReceived;
    existing.totalSpentSol += amountSol;
  } else {
    wallet.positions.push({
      coinId:        token.mintAddress,
      symbol:        token.symbol,
      name:          token.name,
      buyPrice:      token.currentPrice,
      amount:        tokensReceived,
      totalSpentSol: amountSol,
      boughtAt:      new Date().toISOString(),
      riskScore,
      mintAddress:   token.mintAddress,
    });
  }

  const event: TradeEvent = {
    id:              wallet.tradeCount,
    symbol:          token.symbol,
    name:            token.name,
    mintAddress:     token.mintAddress,
    action:          "BUY",
    solSpent:        amountSol,
    tokensReceived,
    price:           token.currentPrice,
    riskScore,
    timestamp:       new Date().toISOString(),
  };
  wallet.tradeLog.unshift(event);          // newest first
  if (wallet.tradeLog.length > 100) wallet.tradeLog.pop(); // keep log bounded

  saveWallet(wallet);
  return tokensReceived;
}

/** Append a BLOCKED event to the trade log without touching balances. */
function logBlockedTrade(token: TokenData, reason: string): void {
  const event: TradeEvent = {
    id:          wallet.tradeCount,
    symbol:      token.symbol,
    name:        token.name,
    mintAddress: token.mintAddress,
    action:      "BLOCKED",
    reason,
    timestamp:   new Date().toISOString(),
  };
  wallet.tradeLog.unshift(event);
  if (wallet.tradeLog.length > 100) wallet.tradeLog.pop();
  saveWallet(wallet);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny HTTP API server (no Express dependency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serves two endpoints consumed by the Vite frontend:
 *   GET /api/wallet  — full wallet state as JSON
 *   GET /api/health  — liveness check
 *
 * CORS headers allow the Vite dev server (localhost:5173) to call freely.
 */
function startApiServer(): void {
  const server = http.createServer((req, res) => {
    // CORS — allow the Vite dev server
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url?.split("?")[0];

    if (url === "/api/wallet") {
      // Always serve the latest in-memory state (already synced to disk)
      res.writeHead(200);
      res.end(JSON.stringify(wallet));
      return;
    }

    if (url === "/api/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(API_PORT, "127.0.0.1", () => {
    log("INFO", `API server listening on http://127.0.0.1:${API_PORT}`);
    log("INFO", `  GET /api/wallet  — live wallet state`);
    log("INFO", `  GET /api/health  — liveness check`);
  });

  server.on("error", (err) => {
    log("ERROR", `API server error: ${err.message}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock token pool
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_TOKENS: TokenData[] = [
  { name: "Baby Doge Coin",   symbol: "BABYDOGE",  mintAddress: "BabyD0geXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 420_000_000_000_000, decimals: 9, creatorAddress: "Creator1XXX", holders: 142_000, liquidityUsd: 3_200_000, ageHours: 720  },
  { name: "SketchyMoon",      symbol: "SKMN",      mintAddress: "SketchyMoon1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000,   decimals: 9, creatorAddress: "Creator2XXX", holders: 7,       liquidityUsd: 180,       ageHours: 0.5  },
  { name: "Floki Inu",        symbol: "FLOKI",     mintAddress: "Fl0k1InuXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 10_000_000_000_000,  decimals: 9, creatorAddress: "Creator3XXX", holders: 89_000,  liquidityUsd: 920_000,   ageHours: 2160 },
  { name: "AquaGoat Finance", symbol: "AQUAGOAT",  mintAddress: "AquaGoatXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 100_000_000_000,     decimals: 9, creatorAddress: "Creator4XXX", holders: 3,       liquidityUsd: 62,        ageHours: 1,   metadata: { website: null } },
  { name: "EverGrow Coin",    symbol: "EGC",       mintAddress: "EverGrowXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000_000, decimals: 9, creatorAddress: "Creator5XXX", holders: 54_000, liquidityUsd: 450_000,   ageHours: 4320 },
  { name: "SafeMoon",         symbol: "SFM",       mintAddress: "SafeM00nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000,   decimals: 9, creatorAddress: "Creator6XXX", holders: 31_000,  liquidityUsd: 210_000,   ageHours: 960  },
];

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
    liquidityUsd: base.liquidityUsd != null ? Math.round(base.liquidityUsd * (0.5 + Math.random())) : undefined,
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
// Ollama integration
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(token: TokenData): string {
  return `You are a crypto token risk analyst. Evaluate the following Solana token and return a risk score from 0 (safe) to 100 (extremely risky).

Token:
- Name: ${token.name}  Symbol: ${token.symbol}
- Total Supply: ${token.totalSupply.toLocaleString()}  Holders: ${token.holders ?? "unknown"}
- Liquidity: ${token.liquidityUsd != null ? "$" + token.liquidityUsd.toLocaleString() : "unknown"}
- Age: ${token.ageHours ?? "unknown"}h
${token.metadata ? "- Metadata: " + JSON.stringify(token.metadata) : ""}

Respond ONLY in this format:
RISK_SCORE: <0-100>
EXPLANATION: <one sentence>`.trim();
}

function parseRiskScore(raw: string): number | null {
  const match = raw.match(/RISK_SCORE:\s*(\d{1,3})/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return n >= 0 && n <= 100 ? n : null;
}

async function analyzeTokenWithOllama(token: TokenData): Promise<TokenRiskAnalysis> {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);
  let response: Response;
  try {
    response = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model: OLLAMA_MODEL, prompt: buildPrompt(token), stream: false }),
      signal:  controller.signal,
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
  const json = (await response.json()) as OllamaResponse;
  return { raw: json.response, riskScore: parseRiskScore(json.response), model: json.model, analyzedAt: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4-Step Verification Pipeline
// ─────────────────────────────────────────────────────────────────────────────

export async function processAutonomousTradeFlow(
  token: TokenData & { currentPrice: number },
): Promise<PipelineResult> {
  const tag = `[${token.symbol}]`;

  // ── Filter 1 · Metadata ────────────────────────────────────────────────────
  log("FILTER", `${tag} Filter 1 — Metadata`);
  const missingName   = !token.name?.trim();
  const missingSymbol = !token.symbol?.trim();
  const tooFewHolders = (token.holders ?? 0) <= 10;
  if (missingName || missingSymbol || tooFewHolders) {
    const reason = [missingName && "missing name", missingSymbol && "missing symbol", tooFewHolders && `holders ≤ 10 (got ${token.holders ?? 0})`].filter(Boolean).join(", ");
    log("FILTER", `${tag} ✗ Filter 1 FAILED — ${reason}`);
    return { passed: false, reason: `Metadata: ${reason}` };
  }
  log("FILTER", `${tag} ✓ Filter 1 passed`);

  // ── Filter 2 · Security ────────────────────────────────────────────────────
  log("FILTER", `${tag} Filter 2 — Security`);
  const sec = fetchSecurityProfile(token);
  if (!sec.mintAuthorityDisabled || !sec.liquidityLocked) {
    const reason = [!sec.mintAuthorityDisabled && "mint authority active", !sec.liquidityLocked && "liquidity unlocked"].filter(Boolean).join(", ");
    log("FILTER", `${tag} ✗ Filter 2 FAILED — ${reason}`);
    return { passed: false, reason: `Security: ${reason}` };
  }
  log("FILTER", `${tag} ✓ Filter 2 passed — mint disabled & liquidity locked`);

  // ── Filter 3 · Ollama AI ───────────────────────────────────────────────────
  log("FILTER", `${tag} Filter 3 — Ollama AI (${OLLAMA_MODEL})`);
  let analysis: TokenRiskAnalysis;
  try {
    analysis = await analyzeTokenWithOllama(token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("WARN", `${tag} ⚠ Ollama unavailable — skipping safely (${msg})`);
    return { passed: false, reason: `Ollama unavailable: ${msg}` };
  }

  const { riskScore, raw } = analysis;
  if (riskScore === null) {
    log("WARN", `${tag} ⚠ Unparseable risk score — vetoing`);
    return { passed: false, reason: "AI: unparseable risk score" };
  }
  if (riskScore > MAX_RISK) {
    log("FILTER", `${tag} ❌ AI Vetoed: Risk Score Too High (${riskScore} > ${MAX_RISK})`);
    return { passed: false, reason: `AI veto: risk ${riskScore} > ${MAX_RISK}` };
  }
  const explanation = raw.split("\n").find(l => /explanation:/i.test(l)) ?? raw.slice(0, 80);
  log("FILTER", `${tag} ✓ Filter 3 passed — score ${riskScore}. ${explanation}`);

  // ── Filter 4 · Moving Average ──────────────────────────────────────────────
  log("FILTER", `${tag} Filter 4 — ${MA_PERIODS}-period MA`);
  const history  = getOrInitPriceHistory(token.symbol, token.currentPrice);
  const window   = history.slice(-MA_PERIODS);
  const maAvg    = window.reduce((s, p) => s + p, 0) / window.length;
  const price    = token.currentPrice;
  history.push(price);
  if (history.length > MA_PERIODS * 4) history.splice(0, 1);

  if (price <= maAvg) {
    log("FILTER", `${tag} ✗ Filter 4 FAILED — ${price.toFixed(8)} ≤ avg ${maAvg.toFixed(8)}`);
    return { passed: false, reason: `MA: price below ${MA_PERIODS}-period average` };
  }
  log("FILTER", `${tag} ✓ Filter 4 passed — ${price.toFixed(8)} > avg ${maAvg.toFixed(8)}`);

  return { passed: true, riskScore, maAvg, price };
}

// ─────────────────────────────────────────────────────────────────────────────
// Trading cycle
// ─────────────────────────────────────────────────────────────────────────────

async function runTradingCycle(cycleNum: number): Promise<void> {
  const token = pickRandomToken();

  log("INFO", `${"─".repeat(56)}`);
  log("INFO", `Cycle #${cycleNum} | ${token.name} (${token.symbol}) @ ${token.currentPrice.toFixed(8)} SOL`);

  const result = await processAutonomousTradeFlow(token);

  if (!result.passed) {
    log("INFO", `  ⛔ Blocked — ${result.reason}`);
    logBlockedTrade(token, result.reason);
    return;
  }

  let tokensAcquired: number;
  try {
    tokensAcquired = executeBuy(token, result.riskScore, BUY_SOL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("WARN", `  ⚠ Buy failed — ${msg}`);
    logBlockedTrade(token, `Buy failed: ${msg}`);
    return;
  }

  const allocation = ((BUY_SOL / (wallet.solBalance + BUY_SOL)) * 100).toFixed(2);
  banner("█",
    `🚀 TRADE #${wallet.tradeCount} EXECUTED — ${token.name} (${token.symbol})\n` +
    `  Mint          : ${token.mintAddress}\n` +
    `  Price         : ${result.price.toFixed(8)} SOL/token\n` +
    `  SOL spent     : ${BUY_SOL}  |  Tokens received: ${tokensAcquired.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n` +
    `  AI risk score : ${result.riskScore}/100 ✓   MA signal: above avg ✓\n` +
    `  Remaining SOL : ${wallet.solBalance.toFixed(4)}  |  Allocation: ${allocation}%\n` +
    `  Positions held: ${wallet.positions.length}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

let cycleCount = 0;

async function tick(): Promise<void> {
  cycleCount++;
  try {
    await runTradingCycle(cycleCount);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Unhandled error in cycle #${cycleCount}: ${msg}`);
    log("WARN",  `Daemon continuing — next tick in ${INTERVAL_MS / 1000}s`);
  }
}

banner("=",
  "CoinPortal Autonomous Trading Agent\n" +
  `  Wallet path : ${WALLET_PATH}\n` +
  `  API port    : ${API_PORT}\n` +
  `  Ollama URL  : ${OLLAMA_URL}\n` +
  `  Model       : ${OLLAMA_MODEL}\n` +
  `  Interval    : ${INTERVAL_MS / 1000}s  |  Buy: ${BUY_SOL} SOL  |  Max risk: ${MAX_RISK}  |  MA: ${MA_PERIODS}p`
);

startApiServer();
tick();
setInterval(tick, INTERVAL_MS);

process.on("SIGTERM", () => { log("INFO", "SIGTERM — flushing wallet and shutting down"); saveWallet(wallet); process.exit(0); });
process.on("SIGINT",  () => { log("INFO", "SIGINT  — flushing wallet and shutting down"); saveWallet(wallet); process.exit(0); });
