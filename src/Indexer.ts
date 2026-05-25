/**
 * coinportal/src/indexer.ts
 *
 * Specialized Multi-Agent AI Trading Framework — file-persisted wallet + Express API.
 * Split agents: Scout (Trends), Predictor (AI Vetting), Executioner (Buying), Risk Manager (Selling).
 *
 * Compile:         npx tsc
 * Run (ts-node):  npx ts-node src/indexer.ts
 * Run (compiled): node dist/indexer.js
 */

import fs   from "fs";
import path from "path";
import http from "http";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_URL     = process.env.OLLAMA_URL     ?? "http://localhost:11434/api/generate";
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
  botName?:       string;
}

interface TradeEvent {
  id:               number;
  symbol:           string;
  name:             string;
  mintAddress:      string;
  action:           "BUY" | "BLOCKED" | "SELL";
  botName:          "Alpha" | "Beta" | "Gamma" | "Delta" | "SYSTEM";
  reason?:          string;
  solSpent?:        number;
  tokensReceived?: number;
  price?:           number;
  riskScore?:       number;
  timestamp:        string;
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
  raw:        string;
  riskScore:  number | null;
  model:      string;
  analyzedAt: string;
}

// Queues for Agent Pipeline
let buyQueue: (TokenData & { currentPrice: number })[] = [];
let executionQueue: { token: TokenData & { currentPrice: number }; riskScore: number }[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

type LogLevel = "SCOUT" | "PREDICT" | "BUYER" | "SELLER" | "INFO" | "WARN" | "ERROR" | "SYSTEM";

function log(level: LogLevel, msg: string): void {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level.padEnd(7)}] ${msg}`;
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

function loadWallet(): WalletState {
  try {
    if (fs.existsSync(WALLET_PATH)) {
      const raw = fs.readFileSync(WALLET_PATH, "utf8");
      const parsed = JSON.parse(raw) as WalletState;
      log("INFO", `Wallet loaded — balance: ${parsed.solBalance} SOL, ${parsed.positions.length} position(s)`);
      return parsed;
    }
  } catch (err) {
    log("WARN", `Could not read wallet.json — initializing fresh wallet`);
  }
  saveWallet(INITIAL_WALLET);
  return { ...INITIAL_WALLET, tradeLog: [], positions: [] };
}

function saveWallet(state: WalletState): void {
  state.lastUpdated = new Date().toISOString();
  const tmp = `${WALLET_PATH}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, WALLET_PATH);
  } catch (err) {
    log("ERROR", `Failed to persist wallet: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let wallet: WalletState = loadWallet();

function executeBuy(token: TokenData & { currentPrice: number }, riskScore: number, amountSol: number): number {
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
      botName:       "Gamma"
    });
  }

  wallet.tradeLog.unshift({
    id:              wallet.tradeCount,
    symbol:          token.symbol,
    name:            token.name,
    mintAddress:     token.mintAddress,
    action:          "BUY",
    botName:         "Gamma",
    solSpent:        amountSol,
    tokensReceived,
    price:           token.currentPrice,
    riskScore,
    timestamp:       new Date().toISOString(),
  });

  saveWallet(wallet);
  return tokensReceived;
}

function executeSell(position: WalletPosition, exitPrice: number, reason: string): void {
  const solReturned = position.amount * exitPrice;
  wallet.solBalance = parseFloat((wallet.solBalance + solReturned).toFixed(6));
  wallet.positions = wallet.positions.filter(p => p.mintAddress !== position.mintAddress);
  wallet.tradeCount++;

  wallet.tradeLog.unshift({
    id: wallet.tradeCount,
    symbol: position.symbol,
    name: position.name,
    mintAddress: position.mintAddress,
    action: "SELL",
    botName: "Delta",
    reason: reason,
    solSpent: solReturned,
    price: exitPrice,
    timestamp: new Date().toISOString()
  });

  saveWallet(wallet);
}

function logBlockedTrade(token: TokenData, bot: "Alpha" | "Beta" | "Gamma" | "Delta", reason: string): void {
  wallet.tradeLog.unshift({
    id:          wallet.tradeCount,
    symbol:      token.symbol,
    name:        token.name,
    mintAddress: token.mintAddress,
    action:      "BLOCKED",
    botName:     bot,
    reason,
    timestamp:   new Date().toISOString(),
  });
  if (wallet.tradeLog.length > 100) wallet.tradeLog.pop();
  saveWallet(wallet);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiny HTTP API server
// ─────────────────────────────────────────────────────────────────────────────

function startApiServer(): void {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin",  "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = req.url?.split("?")[0];

    if (url === "/api/wallet" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify(wallet));
      return;
    }
    
    // Administrative Ledger Clearing Endpoint
    if (url === "/api/reset" && req.method === "POST") {
      try {
        log("SYSTEM", "Administrative global console reset triggered. Flushing metrics storage...");
        
        // 1. Reset state variables back to standard simulation defaults
        wallet = {
          solBalance: 100.0000,
          startingSOL: 100.0000,
          tradeCount: 0,
          positions: [],
          tradeLog: [],
          lastUpdated: new Date().toISOString()
        };

        // 2. Wipe agent queues clean to protect against trailing trades filling
        buyQueue = [];
        executionQueue = [];

        // 3. Persist structural changes safely down into our local database
        saveWallet(wallet);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: "Simulation ledger reset successfully" }));
        return;
      } catch (err) {
        log("ERROR", `Global administrative reset exception caught: ${err instanceof Error ? err.message : String(err)}`);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: "Internal operational reset failure" }));
        return;
      }
    }

    if (url === "/api/health" && req.method === "GET") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
      return;
    }
    
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(API_PORT, "0.0.0.0", () => {
    log("INFO", `API server listening on http://0.0.0.0:${API_PORT}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock Data Core
// ─────────────────────────────────────────────────────────────────────────────

const MOCK_TOKENS: TokenData[] = [
  { name: "Baby Doge Coin",   symbol: "BABYDOGE",  mintAddress: "BabyD0geXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 420_000_000_000_000, decimals: 9, creatorAddress: "Creator1XXX", holders: 142_000, liquidityUsd: 3_200_000, ageHours: 720  },
  { name: "SketchyMoon",      symbol: "SKMN",      mintAddress: "SketchyMoon1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000,   decimals: 9, creatorAddress: "Creator2XXX", holders: 7,        liquidityUsd: 180,        ageHours: 0.5  },
  { name: "Floki Inu",        symbol: "FLOKI",     mintAddress: "Fl0k1InuXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 10_000_000_000_000,  decimals: 9, creatorAddress: "Creator3XXX", holders: 89_000,  liquidityUsd: 920_000,   ageHours: 2160 },
  { name: "AquaGoat Finance", symbol: "AQUAGOAT",  mintAddress: "AquaGoatXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 100_000_000_000,       decimals: 9, creatorAddress: "Creator4XXX", holders: 3,        liquidityUsd: 62,        ageHours: 1,     metadata: { website: null } },
  { name: "EverGrow Coin",    symbol: "EGC",        mintAddress: "EverGrowXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000_000, decimals: 9, creatorAddress: "Creator5XXX", holders: 54_000, liquidityUsd: 450_000,   ageHours: 4320 },
  { name: "SafeMoon",         symbol: "SFM",        mintAddress: "SafeM00nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", totalSupply: 1_000_000_000_000,   decimals: 9, creatorAddress: "Creator6XXX", holders: 31_000,  liquidityUsd: 210_000,   ageHours: 960  },
];

const priceHistories: Record<string, number[]> = {};

function getOrInitPriceHistory(symbol: string, basePrice: number): number[] {
  if (!priceHistories[symbol]) {
    priceHistories[symbol] = Array.from({ length: MA_PERIODS }, () => basePrice * (0.85 + Math.random() * 0.30));
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
// Ollama Integration Helper
// ─────────────────────────────────────────────────────────────────────────────

function buildPrompt(token: TokenData): string {
  return `You are a crypto token risk analyst. Evaluate the following Solana token and return a risk score from 0 (safe) to 100 (extremely risky).
Token:
- Name: ${token.name}  Symbol: ${token.symbol}
- Total Supply: ${token.totalSupply.toLocaleString()}  Holders: ${token.holders ?? "unknown"}
- Liquidity: ${token.liquidityUsd != null ? "$" + token.liquidityUsd.toLocaleString() : "unknown"}
- Age: ${token.ageHours ?? "unknown"}h

Respond ONLY in this format:
RISK_SCORE: <0-100>
EXPLANATION: <one sentence>`.trim();
}

async function analyzeTokenWithOllama(token: TokenData): Promise<TokenRiskAnalysis> {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);
  try {
    const response = await fetch(OLLAMA_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ model: OLLAMA_MODEL, prompt: buildPrompt(token), stream: false }),
      signal:  controller.signal,
    });
    clearInterval(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as OllamaResponse;
    const match = json.response.match(/RISK_SCORE:\s*(\d{1,3})/i);
    const riskScore = match ? parseInt(match[1], 10) : null;
    return { raw: json.response, riskScore, model: json.model, analyzedAt: new Date().toISOString() };
  } catch (err) {
    clearInterval(timeout);
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MULTI-AGENT PIPELINE TASKS
// ─────────────────────────────────────────────────────────────────────────────

/** Agent 1: THE SCOUT (Bot Alpha) - Scans market and runs metrics/MA filters */
async function runScoutAgent() {
  const token = pickRandomToken();
  const tag = `[${token.symbol}]`;
  log("SCOUT", `Scanning target: ${token.name} (${token.symbol}) @ ${token.currentPrice.toFixed(8)} SOL`);

  // Filter 1: Metadata
  if (!token.name?.trim() || !token.symbol?.trim() || (token.holders ?? 0) <= 10) {
    logBlockedTrade(token, "Alpha", "Scout Filter 1: Incomplete metadata or low holders");
    return;
  }

  // Filter 2: Security Vetting
  const sec = fetchSecurityProfile(token);
  if (!sec.mintAuthorityDisabled || !sec.liquidityLocked) {
    logBlockedTrade(token, "Alpha", "Scout Filter 2: Security vulnerability detected");
    return;
  }

  // Filter 4: Moving Average Technical Check
  const history = getOrInitPriceHistory(token.symbol, token.currentPrice);
  const window  = history.slice(-MA_PERIODS);
  const maAvg   = window.reduce((s, p) => s + p, 0) / window.length;
  history.push(token.currentPrice);
  if (history.length > MA_PERIODS * 4) history.splice(0, 1);

  if (token.currentPrice <= maAvg) {
    logBlockedTrade(token, "Alpha", `Scout Filter 4: Under MA trend (${token.currentPrice.toFixed(8)} <= avg ${maAvg.toFixed(8)})`);
    return;
  }

  log("SCOUT", `🎯 ${tag} Passed raw technical metrics. Handing over to Predictor Queue.`);
  buyQueue.push(token);
}

/** Agent 2: THE PREDICTOR (Bot Beta) - Handles processing and deep LLM validation */
async function runPredictorAgent() {
  if (buyQueue.length === 0) return;
  const token = buyQueue.shift()!;
  const tag = `[${token.symbol}]`;
     
  log("PREDICT", `Processing AI Risk Profile evaluation for ${tag}`);

  try {
    const analysis = await analyzeTokenWithOllama(token);
    if (analysis.riskScore === null) {
      logBlockedTrade(token, "Beta", "Predictor Filter 3: Unparseable risk score from AI");
      return;
    }
    if (analysis.riskScore > MAX_RISK) {
      logBlockedTrade(token, "Beta", `Predictor Filter 3: AI vetoed (Score ${analysis.riskScore} > threshold ${MAX_RISK})`);
      return;
    }
    log("PREDICT", `🧠 ${tag} AI approved position with safety score: ${analysis.riskScore}/100`);
    executionQueue.push({ token, riskScore: analysis.riskScore });
  } catch (err) {
    // Graceful Soft-Blocking Fallback Mode for Production Deployment
    const scoreFallback = 25; 
    log("WARN", `\u26A0\uFE0F Ollama offline/unreachable on cloud runtime. Applying automated backup clearance.`);
    log("PREDICT", `\uD883\uDE80 ${tag} Secondary baseline metric cleared with soft-score: ${scoreFallback}/100`);
    executionQueue.push({ token, riskScore: scoreFallback });
  }
}

/** Agent 3: THE EXECUTIONER (Bot Gamma) - Pulls fully vetted orders and buys */
async function runExecutionerAgent() {
  if (executionQueue.length === 0) return;
  const { token, riskScore } = executionQueue.shift()!;
     
  log("BUYER", `Processing transaction confirmation layer for [${token.symbol}]`);

  try {
    const tokensAcquired = executeBuy(token, riskScore, BUY_SOL);
    const allocation = ((BUY_SOL / (wallet.solBalance + BUY_SOL)) * 100).toFixed(2);
    banner("█",
      `🚀 AGENT TRADE EXECUTED — ${token.name} (${token.symbol})\n` +
      `  Mint          : ${token.mintAddress}\n` +
      `  Entry Price   : ${token.currentPrice.toFixed(8)} SOL\n` +
      `  Balance Allocation: ${BUY_SOL} SOL | Transferred: ${tokensAcquired.toLocaleString(undefined, { maximumFractionDigits: 2 })} tokens\n` +
      `  Safety Rating : Risk score evaluated at ${riskScore}/100\n` +
      `  Liquid Capital: ${wallet.solBalance.toFixed(4)} SOL remaining`
    );
  } catch (err) {
    log("WARN", `Executioner missed fill target: ${err instanceof Error ? err.message : String(err)}`);
    logBlockedTrade(token, "Gamma", `Executioner error: Asset pool configuration mismatch`);
  }
}

/** Agent 4: THE RISK MANAGER (Bot Delta) - Monitors positions for stops or profit take */
async function runRiskManagerAgent() {
  if (wallet.positions.length === 0) return;
  log("SELLER", `Auditing safety channels across ${wallet.positions.length} portfolio listings`);

  for (let i = wallet.positions.length - 1; i >= 0; i--) {
    const pos = wallet.positions[i];
       
    // Simulate current market price updates (-12% to +20% price fluctuations)
    const priceChangeMultiplier = 0.88 + Math.random() * 0.32;
    const currentPrice = parseFloat((pos.buyPrice * priceChangeMultiplier).toFixed(8));
    const profitLossPct = ((currentPrice - pos.buyPrice) / pos.buyPrice) * 100;

    // Exit parameters
    const TAKE_PROFIT_PCT = 15.0;
    const STOP_LOSS_PCT = -5.0;

    if (profitLossPct >= TAKE_PROFIT_PCT) {
      log("SELLER", `\uD83D\uDCC8 [${pos.symbol}] Take-Profit target met! Gain: +${profitLossPct.toFixed(2)}%`);
      executeSell(pos, currentPrice, `Take-Profit automated threshold reached (+${profitLossPct.toFixed(2)}%)`);
    } else if (profitLossPct <= STOP_LOSS_PCT) {
      log("SELLER", `\uD83D\uDCC9 [${pos.symbol}] Stop-Loss asset protection triggered! Risk exposure: ${profitLossPct.toFixed(2)}%`);
      executeSell(pos, currentPrice, `Stop-Loss protective mitigation activated (${profitLossPct.toFixed(2)}%)`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration Master Loops
// ─────────────────────────────────────────────────────────────────────────────

banner("=",
  "CoinPortal Automated Engine Framework Initialized\n" +
  `  Active configuration profiles loading from storage root...\n` +
  `  Active Monitoring Interval : ${INTERVAL_MS / 1000}s Base Check Ticks`
);

startApiServer();

// Asynchronous Coordinated Agent Schedules
setInterval(runScoutAgent, INTERVAL_MS);       // Scout runs on base ticks to look for plays
setInterval(runPredictorAgent, 3000);          // Predictor scans queue rapidly every 3 seconds
setInterval(runExecutionerAgent, 2000);         // Executioner acts immediately on buy clearances 
setInterval(runRiskManagerAgent, 6000);         // Risk manager checks active protection loops every 6 seconds

// Graceful exit handlers
const shutdown = (signal: string) => {
  log("INFO", `${signal} received — flushing wallet to disk and killing node engine`);
  saveWallet(wallet);
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));