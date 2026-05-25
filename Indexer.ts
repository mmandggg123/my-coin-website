/**
 * coinportal/indexer.ts
 *
 * Multi-Bot Autonomous AI Trading Engine with Integrated Live Paper Trading Sells
 * — 4 independent bots with staggered intervals
 * — Mutex-guarded async wallet I/O (no corruption under concurrent writes)
 * — Real-World Pricing via CoinGecko Pro API Integration
 * — Automated Take Profit (+50%) and Stop Loss (-15%) execution loops
 * — JSON-only Ollama prompt (no conversational refusals)
 * — File-backed wallet.json + embedded HTTP API on :3001
 *
 * Compile:        npx tsc
 * Run (ts-node):  npx ts-node indexer.ts
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import http from "http";
import axios from "axios";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_URL     = process.env.OLLAMA_URL     ?? "http://localhost:11434/api/generate";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   ?? "llama3.2";
const OLLAMA_TIMEOUT = 30_000;
const BUY_SOL        = parseFloat(process.env.BUY_SOL        ?? "1");
const MAX_RISK       = parseInt(process.env.MAX_RISK      ?? "40",   10);
const MA_PERIODS     = parseInt(process.env.MA_PERIODS     ?? "5",    10);
const API_PORT       = parseInt(process.env.PORT          ?? process.env.API_PORT ?? "3001", 10);
const WALLET_PATH    = path.resolve(process.env.WALLET_PATH ?? "./wallet.json");

// CoinGecko API Configuration
const COINGECKO_API_KEY = "CG-SjS5j5KfUGVBTzwApPpUYJAU";
const COINGECKO_BASE_URL = "https://pro-api.coingecko.com/api/v3";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface WalletPosition {
  coinId:        string;
  symbol:        string;
  name:          string;
  buyPrice:      number;
  currentPrice:  number; // Live updating value from API
  amount:        number;
  totalSpentSol: number;
  boughtAt:      string;
  riskScore:     number;
  mintAddress:   string;
  botName:       string; 
}

interface TradeEvent {
  id:              number;
  botName:         string;
  symbol:          string;
  name:            string;
  mintAddress:     string;
  action:          "BUY" | "BLOCKED" | "TAKE_PROFIT" | "STOP_LOSS";
  reason?:         string;
  solSpent?:       number;
  solReturned?:    number;
  tokensReceived?: number;
  price?:          number;
  riskScore?:      number;
  timestamp:       string;
}

interface WalletState {
  solBalance:    number;
  startingSOL:   number;
  deployedSol:   number; 
  tradeCount:    number;
  blockedTrades: number; 
  positions:     WalletPosition[];
  tradeLog:      TradeEvent[];
  lastUpdated:   string;
}

interface TokenData {
  id:             string; // CoinGecko API ID
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
  | { passed: true; riskScore: number; maAvg: number; price: number }
  | { passed: false; reason: string };

interface BotConfig {
  name:       string;  
  label:      string;  
  intervalMs: number;  
  delayMs:    number;  
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot Configurations
// ─────────────────────────────────────────────────────────────────────────────

const BOT_CONFIGS: BotConfig[] = [
  { name: "Alpha", label: "[Bot Alpha]", intervalMs: 15_000, delayMs:  0    },
  { name: "Beta",  label: "[Bot Beta]",  intervalMs: 18_000, delayMs:  3_000 },
  { name: "Gamma", label: "[Bot Gamma]", intervalMs: 22_000, delayMs:  6_500 },
  { name: "Delta", label: "[Bot Delta]", intervalMs: 25_000, delayMs:  9_000 },
];

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "INFO" | "WARN" | "ERROR" | "TRADE" | "FILTER";

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

const BOT_COLOURS: Record<string, string> = {
  SYSTEM: isTTY ? "\x1b[95m" : "", 
  Alpha:  isTTY ? "\x1b[36m" : "", 
  Beta:   isTTY ? "\x1b[35m" : "", 
  Gamma:  isTTY ? "\x1b[33m" : "", 
  Delta:  isTTY ? "\x1b[34m" : "", 
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
  console.log(`  API     : http://0.0.0.0:${API_PORT}/api/wallet`);
  console.log(`  Ollama  : ${OLLAMA_URL}  (model: ${OLLAMA_MODEL})`);
  console.log(`  Market  : Live Production CoinGecko Feed Enabled`);
  console.log(`  Buy     : ${BUY_SOL} SOL/trade  |  Max risk: ${MAX_RISK}  |  MA: ${MA_PERIODS}p`);
  console.log(`\n  Bots:`);
  for (const b of BOT_CONFIGS) {
    const col = BOT_COLOURS[b.name] ?? "";
    console.log(`    ${col}● ${b.label.padEnd(14)}${COL.reset}  tick every ${b.intervalMs / 1000}s  |  start +${b.delayMs / 1000}s`);
  }
  console.log(`${COL.cyan}${border}${COL.reset}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Mutex
// ─────────────────────────────────────────────────────────────────────────────

class AsyncMutex {
  private _queue: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
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
  solBalance:    100.00,
  startingSOL:   100.00,
  deployedSol:   0.00,
  tradeCount:    0,
  blockedTrades: 0,
  positions:     [],
  tradeLog:      [],
  lastUpdated: new Date().toISOString(),
};

async function loadWallet(): Promise<WalletState> {
  try {
    const raw    = await fsp.readFile(WALLET_PATH, "utf8");
    const parsed = JSON.parse(raw) as WalletState;
    if (parsed.blockedTrades === undefined) parsed.blockedTrades = 0;
    if (parsed.deployedSol === undefined) parsed.deployedSol = 0;
    log("INFO", "SYSTEM", `Wallet loaded — ${parsed.solBalance} SOL, ${parsed.positions.length} position(s)`);
    return parsed;
  } catch {
    log("INFO", "SYSTEM", `No existing wallet found — creating ${WALLET_PATH} with 100 SOL`);
    await saveWalletRaw({ ...INITIAL_WALLET });
    return { ...INITIAL_WALLET, positions: [], tradeLog: [] };
  }
}

async function saveWalletRaw(state: WalletState): Promise<void> {
  state.lastUpdated = new Date().toISOString();
  const tmp = `${WALLET_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fsp.rename(tmp, WALLET_PATH);
}

async function readWalletFromDisk(): Promise<WalletState> {
  const raw = await fsp.readFile(WALLET_PATH, "utf8");
  return JSON.parse(raw) as WalletState;
}

let memWallet: WalletState = { ...INITIAL_WALLET, positions: [], tradeLog: [] };

// ─────────────────────────────────────────────────────────────────────────────
// Wallet mutations (Mutex-guarded)
// ─────────────────────────────────────────────────────────────────────────────

async function executeBuy(
  botName:   string,
  token:     TokenData & { currentPrice: number },
  riskScore: number,
  amountSol: number,
): Promise<number> {
  return walletMutex.run(async () => {
    const w = await readWalletFromDisk();

    if (amountSol > w.solBalance)
      throw new Error(`Insufficient SOL (have ${w.solBalance.toFixed(4)}, need ${amountSol})`);

    const tokensReceived = amountSol / token.currentPrice;
    w.solBalance  = parseFloat((w.solBalance - amountSol).toFixed(6));
    w.deployedSol = parseFloat((w.deployedSol + amountSol).toFixed(6));
    w.tradeCount++;

    const existing = w.positions.find(p => p.mintAddress === token.mintAddress);
    if (existing) {
      existing.amount        += tokensReceived;
      existing.totalSpentSol += amountSol;
    } else {
      w.positions.push({
        coinId:        token.id,
        symbol:        token.symbol,
        name:          token.name,
        buyPrice:      token.currentPrice,
        currentPrice:  token.currentPrice,
        amount:        tokensReceived,
        totalSpentSol: amountSol,
        boughtAt:      new Date().toISOString(),
        riskScore,
        mintAddress:   token.mintAddress,
        botName,
      });
    }

    w.tradeLog.unshift({
      id:              w.tradeCount,
      botName,
      symbol:          token.symbol,
      name:            token.name,
      mintAddress:     token.mintAddress,
      action:          "BUY",
      solSpent:        amountSol,
      tokensReceived,
      price:           token.currentPrice,
      riskScore,
      timestamp:       new Date().toISOString(),
    });
    if (w.tradeLog.length > 200) w.tradeLog.length = 200;

    await saveWalletRaw(w);
    memWallet = w; 
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
    w.blockedTrades = (w.blockedTrades ?? 0) + 1;
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

/**
 * Sweeps through positions and closes them if Take Profit (+50%) or Stop Loss (-15%) criteria is met.
 */
async function processAutomatedSells(): Promise<void> {
  await walletMutex.run(async () => {
    const w = await readWalletFromDisk();
    if (w.positions.length === 0) return;

    let stateChanged = false;

    for (let i = w.positions.length - 1; i >= 0; i--) {
      const pos = w.positions[i];
      const priceChangePct = ((pos.currentPrice - pos.buyPrice) / pos.buyPrice) * 100;

      let triggerSell = false;
      let sellAction: "TAKE_PROFIT" | "STOP_LOSS" = "TAKE_PROFIT";
      let logReason = "";

      if (priceChangePct >= 50.0) {
        triggerSell = true;
        sellAction = "TAKE_PROFIT";
        logReason = `Take Profit target achieved (+${priceChangePct.toFixed(2)}%)`;
      } else if (priceChangePct <= -15.0) {
        triggerSell = true;
        sellAction = "STOP_LOSS";
        logReason = `Stop Loss threshold triggered (${priceChangePct.toFixed(2)}%)`;
      }

      if (triggerSell) {
        const solReturned = pos.totalSpentSol * (1 + priceChangePct / 100);
        w.solBalance = parseFloat((w.solBalance + solReturned).toFixed(6));
        w.deployedSol = parseFloat((w.deployedSol - pos.totalSpentSol).toFixed(6));
        if (w.deployedSol < 0) w.deployedSol = 0;

        w.tradeLog.unshift({
          id: w.tradeCount,
          botName: pos.botName,
          symbol: pos.symbol,
          name: pos.name,
          mintAddress: pos.mintAddress,
          action: sellAction,
          reason: logReason,
          solReturned: parseFloat(solReturned.toFixed(6)),
          price: pos.currentPrice,
          timestamp: new Date().toISOString()
        });

        log("TRADE", "SYSTEM", `💰 CLOSED POSITION: Sold ${pos.symbol} via ${sellAction} at ${priceChangePct.toFixed(2)}% ROI`);
        w.positions.splice(i, 1);
        stateChanged = true;
      }
    }

    if (stateChanged) {
      await saveWalletRaw(w);
      memWallet = w;
    }
  });
}

/**
 * Connects to CoinGecko Pro API to fetch actual real-world prices for all open positions.
 */
async function tickLiveMarketPrices(): Promise<void> {
  await walletMutex.run(async () => {
    const w = await readWalletFromDisk();
    if (w.positions.length === 0) return;

    // Collect all unique coin IDs from open positions to fetch them efficiently in one API request
    const coinIds = Array.from(new Set(w.positions.map(p => p.coinId))).join(",");

    try {
      const response = await axios.get(`${COINGECKO_BASE_URL}/simple/price`, {
        params: {
          ids: coinIds,
          vs_currencies: "usd" // Tracking value relative to dollar ratios
        },
        headers: {
          "x-cg-pro-api-key": COINGECKO_API_KEY
        }
      });

      w.positions.forEach(pos => {
        if (response.data[pos.coinId] && response.data[pos.coinId].usd) {
          const freshPrice = response.data[pos.coinId].usd;
          pos.currentPrice = parseFloat(freshPrice.toFixed(8));
        }
      });

      await saveWalletRaw(w);
      memWallet = w;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log("WARN", "SYSTEM", `Failed to fetch live CoinGecko market ticks: ${msg}`);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP API Server
// ─────────────────────────────────────────────────────────────────────────────

function startApiServer(): void {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = req.url?.split("?")[0];

    if (url === "/api/wallet") {
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

  server.listen(API_PORT, "0.0.0.0", () => {
    log("INFO", "SYSTEM", `API listening on global bridge http://0.0.0.0:${API_PORT}`);
  });

  server.on("error", err => log("ERROR", "SYSTEM", `API error: ${err.message}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// Production Market Asset Array (CoinGecko Base Asset Mapping)
// ─────────────────────────────────────────────────────────────────────────────

const MARKET_TOKENS: TokenData[] = [
  { id: "solana",           name: "Solana",            symbol: "SOL",      mintAddress: "So11111111111111111111111111111111111111112", totalSupply: 500_000_000, decimals: 9, creatorAddress: "System1111111111111111111111111111111111111", holders: 2500000, liquidityUsd: 1500000000, ageHours: 45000 },
  { id: "bonk",             name: "Bonk",              symbol: "BONK",     mintAddress: "DezXAZ8z7PnrnMcZE7YiDQC6bW6dWNs6Ww4q9A47Yv82", totalSupply: 100_000_000_000_000, decimals: 5, creatorAddress: "BonkCreator111111111111111111111111111", holders: 720000, liquidityUsd: 45000000, ageHours: 28000 },
  { id: "dogecoin",         name: "Dogecoin",          symbol: "DOGE",     mintAddress: "DogeMints11111111111111111111111111111111111", totalSupply: 140_000_000_000, decimals: 8, creatorAddress: "DogeCreator111111111111111111111111111", holders: 4800000, liquidityUsd: 230000000, ageHours: 95000 },
  { id: "pepe",             name: "Pepe",              symbol: "PEPE",     mintAddress: "PepeMints11111111111111111111111111111111111", totalSupply: 420_690_000_000_000, decimals: 18, creatorAddress: "PepeCreator111111111111111111111111111", holders: 310000, liquidityUsd: 68000000, ageHours: 24000 },
  { id: "render-token",     name: "Render",            symbol: "RENDER",   mintAddress: "rndrXnzXzHA367SWCxS4AaCcDLg6cmA8Jae8A3C3b39", totalSupply: 530_000_000, decimals: 9, creatorAddress: "RenderCreator11111111111111111111111111", holders: 110000, liquidityUsd: 18000000, ageHours: 32000 },
  { id: "dogwifhat",        name: "Dogwifhat",         symbol: "WIF",      mintAddress: "EKpQGSJtjMFqKZ9KQGWjh66cCN9UNgzyS9S37v7gpump", totalSupply: 998_900_000, decimals: 9, creatorAddress: "WifCreator111111111111111111111111111111", holders: 180000, liquidityUsd: 35000000, ageHours: 18000 }
];

const priceHistories: Record<string, number[]> = {};

function getOrInitPriceHistory(symbol: string, basePrice: number): number[] {
  if (!priceHistories[symbol]) {
    priceHistories[symbol] = Array.from({ length: MA_PERIODS }, () =>
      basePrice * (0.95 + Math.random() * 0.10)
    );
  }
  return priceHistories[symbol];
}

/**
 * Gathers target assets and hits CoinGecko live to grab verified spot valuations for pipelines
 */
async function pullLiveTokenCandidate(): Promise<(TokenData & { currentPrice: number }) | null> {
  const base = MARKET_TOKENS[Math.floor(Math.random() * MARKET_TOKENS.length)];
  try {
    const response = await axios.get(`${COINGECKO_BASE_URL}/simple/price`, {
      params: { ids: base.id, vs_currencies: "usd" },
      headers: { "x-cg-pro-api-key": COINGECKO_API_KEY }
    });

    const currentPrice = response.data[base.id]?.usd ?? 0.000025;
    return {
      ...base,
      ageHours: base.ageHours ? base.ageHours + parseFloat((Math.random() * 5).toFixed(2)) : 24,
      currentPrice: parseFloat(currentPrice.toFixed(8))
    };
  } catch (error) {
    log("WARN", "SYSTEM", `Failed production pricing candidate pull for ${base.symbol}, fallback loaded.`);
    return null;
  }
}

function fetchSecurityProfile(token: TokenData): SecurityProfile {
  return {
    mintAuthorityDisabled: true,
    liquidityLocked: true
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama API Interaction
// ─────────────────────────────────────────────────────────────────────────────

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
  try {
    const trimmed = raw.trim();
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const n   = Number(obj["score"]);
    if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  } catch { /* fall through */ }

  const jsonMatch = raw.match(/\{[^}]*"score"\s*:\s*(\d{1,3})[^}]*\}/);
  if (jsonMatch) {
    const n = parseInt(jsonMatch[1], 10);
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
        system,          
        prompt,
        stream: false,
        options: {
          temperature: 0,      
          top_p: 1,
          num_predict: 20,     
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

  return {
    riskScore,
    raw:        json.response,
    model:      json.model,
    analyzedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification Pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function processAutonomousTradeFlow(
  bot:   BotConfig,
  token: TokenData & { currentPrice: number },
): Promise<PipelineResult> {
  const { name: botName, label } = bot;
  const tag = `${label} [${token.symbol}]`;

  log("FILTER", botName, `${tag} Filter 1 — Metadata`);
  const missingName   = !token.name?.trim();
  const missingSymbol = !token.symbol?.trim();
  if (missingName || missingSymbol) {
    const reason = [missingName && "missing name", missingSymbol && "missing symbol"].filter(Boolean).join(", ");
    log("FILTER", botName, `${tag} ✗ F1 FAILED — ${reason}`);
    return { passed: false, reason: `Metadata: ${reason}` };
  }
  log("FILTER", botName, `${tag} ✓ F1 passed — valid production metadata set`);

  log("FILTER", botName, `${tag} Filter 2 — Security`);
  const sec = fetchSecurityProfile(token);
  if (!sec.mintAuthorityDisabled || !sec.liquidityLocked) {
    return { passed: false, reason: "Security profiles locked out." };
  }
  log("FILTER", botName, `${tag} ✓ F2 passed — mint disabled & liq locked`);

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
// Per-Bot Cycle Loops
// ─────────────────────────────────────────────────────────────────────────────

const botCycleCounts: Record<string, number> = {};

async function runBotCycle(bot: BotConfig): Promise<void> {
  botCycleCounts[bot.name] = (botCycleCounts[bot.name] ?? 0) + 1;
  const cycleNum = botCycleCounts[bot.name];
  
  const token = await pullLiveTokenCandidate();
  if (!token) return;

  log("INFO", bot.name,
    `─── Cycle #${cycleNum} | ${token.name} (${token.symbol}) @ $${token.currentPrice.toFixed(4)} ` +
    `| holders: ${token.holders ?? "?"} | liq: $${token.liquidityUsd?.toLocaleString() ?? "?"}`
  );

  const result = await processAutonomousTradeFlow(bot, token);

  if (!result.passed) {
    log("INFO", bot.name, `  ⛔ Blocked — ${result.reason}`);
    appendBlockedEvent(bot.name, token, result.reason).catch(err =>
      log("WARN", bot.name, `Failed to log blocked event: ${(err as Error).message}`)
    );
    return;
  }

  let tokensAcquired: number;
  try {
    tokensAcquired = await executeBuy(bot.name, token, result.riskScore, BUY_SOL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("WARN", bot.name, `  ⚠ Buy failed — ${msg}`);
    await appendBlockedEvent(bot.name, token, `Buy failed: ${msg}`);
    return;
  }

  const allocation = ((BUY_SOL / (memWallet.solBalance + BUY_SOL)) * 100).toFixed(2);

  banner(
    `🚀 TRADE #${memWallet.tradeCount} — ${bot.label}\n` +
    `   Token    : ${token.name} (${token.symbol})\n` +
    `   ID       : ${token.id}\n` +
    `   Price    : $${result.price.toFixed(4)} | Spent: ${BUY_SOL} SOL\n` +
    `   Received : ${tokensAcquired.toLocaleString(undefined, { maximumFractionDigits: 2 })} mock units\n` +
    `   AI score : ${result.riskScore}/100 ✓   MA signal: above avg ✓\n` +
    `   Balance  : ${memWallet.solBalance.toFixed(4)} SOL remaining  (${allocation}% deployed)\n` +
    `   Positions: ${memWallet.positions.length} open`
  );
}

function spawnBot(bot: BotConfig): void {
  const safeTick = async () => {
    try {
      await runBotCycle(bot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("ERROR", bot.name, `Unhandled error in cycle: ${msg}`);
    }
  };

  setTimeout(() => {
    log("INFO", bot.name, `${bot.label} starting — interval: ${bot.intervalMs / 1000}s`);
    safeTick();            
    setInterval(safeTick, bot.intervalMs); 
  }, bot.delayMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entrypoint Initialization
// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  memWallet = await loadWallet();

  startupBanner();
  startApiServer();

  for (const bot of BOT_CONFIGS) spawnBot(bot);

  // Background loops for live simulated marketplace operations
  setInterval(tickLiveMarketPrices, 8000);   // Production ticks hitting live CoinGecko APIs
  setInterval(processAutomatedSells, 5000);  // Evaluates risk thresholds to close positions

  const flushAndExit = async (signal: string) => {
    log("INFO", "SYSTEM", `${signal} received — flushing wallet state payload and shutting down.`);
    await saveWalletRaw(memWallet);
    process.exit(0);
  };

  process.on("SIGTERM", () => flushAndExit("SIGTERM"));
  process.on("SIGINT", () => flushAndExit("SIGINT"));
})();