/**
 * coinportal/src/App.jsx
 *
 * Fully autonomous dashboard — no Buy buttons, no manual input.
 * Polls GET /api/wallet every 2 s and renders whatever the indexer wrote.
 *
 * Drop-in for the previous CoinPortal.jsx; rename to src/App.jsx in your project.
 */

import { useState, useEffect, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Font injection (runs once)
// ─────────────────────────────────────────────────────────────────────────────

function useFonts() {
  useEffect(() => {
    if (document.getElementById("cp-fonts")) return;
    const l = document.createElement("link");
    l.id   = "cp-fonts";
    l.rel  = "stylesheet";
    l.href = "https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&display=swap";
    document.head.appendChild(l);
  }, []);
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling hook  — hits /api/wallet every 2 s
// ─────────────────────────────────────────────────────────────────────────────

const POLL_MS = 2000;

function useWallet() {
  const [wallet,      setWallet]      = useState(null);
  const [error,       setError]       = useState(null);
  const [lastFetch,   setLastFetch]   = useState(null);
  const [newTrade,    setNewTrade]    = useState(false); // flash flag
  const prevTradeRef  = useRef(0);

  useEffect(() => {
    let alive = true;

    async function poll() {
      try {
        const res = await fetch("/api/wallet");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!alive) return;

        setWallet(data);
        setError(null);
        setLastFetch(new Date());

        // Detect a new trade and trigger the flash animation
        if (data.tradeCount > prevTradeRef.current) {
          prevTradeRef.current = data.tradeCount;
          setNewTrade(true);
          setTimeout(() => setNewTrade(false), 2000);
        } else {
          prevTradeRef.current = data.tradeCount;
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    }

    poll(); // immediate first fetch
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return { wallet, error, lastFetch, newTrade };
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour helpers
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOL_COLORS = {
  BABYDOGE: "#F5A623", SHIB: "#F5C542", FLOKI: "#9B59B6",
  SFM: "#3498DB", EGC: "#E67E22", AQUAGOAT: "#1ABC9C",
};
const DEFAULT_COLORS = ["#E74C3C","#2ECC71","#3498DB","#9B59B6","#F39C12","#1ABC9C"];

// Per-bot accent colours — must match the terminal ANSI scheme in indexer.ts
const BOT_COLORS = {
  Alpha: "#22D3EE",   // cyan
  Beta:  "#C084FC",   // magenta/purple
  Gamma: "#FBBF24",   // amber
  Delta: "#60A5FA",   // blue
  SYSTEM: "#7A7E8C",
};

function symbolColor(symbol, idx = 0) {
  return SYMBOL_COLORS[symbol] ?? DEFAULT_COLORS[idx % DEFAULT_COLORS.length];
}

function riskColor(score) {
  if (score == null) return "#7A7E8C";
  if (score >= 70)   return "#E74C3C";
  if (score >= 40)   return "#F39C12";
  return "#2ECC71";
}

function riskLabel(score) {
  if (score == null) return "—";
  if (score >= 70)   return "HIGH";
  if (score >= 40)   return "MED";
  return "LOW";
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtTokens(n) {
  if (n >= 1e12)  return (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9)   return (n / 1e9).toFixed(2)  + "B";
  if (n >= 1e6)   return (n / 1e6).toFixed(2)  + "M";
  if (n >= 1e3)   return (n / 1e3).toFixed(2)  + "K";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared style tokens
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  bg:      "#0A0B0F",
  surface: "#12141A",
  surface2:"#1A1D26",
  border:  "rgba(255,255,255,0.07)",
  gold:    "#F5C542",
  green:   "#2ECC71",
  red:     "#E74C3C",
  muted:   "#7A7E8C",
  text:    "#F0EEE6",
};

const mono   = "'DM Mono', monospace";
const syne   = "'Syne', sans-serif";
const radius = 14;

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: radius, padding: "1.1rem 1.3rem", minWidth: 130 }}>
      <div style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: C.muted, marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: syne, fontSize: "1.45rem", fontWeight: 800, color: accent ?? C.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 5, letterSpacing: "0.05em" }}>{sub}</div>}
    </div>
  );
}

function PnLBar({ solBalance, startingSOL }) {
  const spent = startingSOL - solBalance;
  const pct   = Math.min((spent / startingSOL) * 100, 100);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: radius, padding: "1rem 1.3rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: C.muted }}>Capital deployed</span>
        <span style={{ fontSize: 11, color: C.gold, fontFamily: mono }}>{spent.toFixed(2)} / {startingSOL} SOL ({pct.toFixed(1)}%)</span>
      </div>
      <div style={{ height: 6, background: C.surface2, borderRadius: 99, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: `linear-gradient(90deg, ${C.green}, ${C.gold})`, borderRadius: 99, transition: "width 0.6s ease" }} />
      </div>
    </div>
  );
}

function PositionCard({ pos, idx }) {
  const color = symbolColor(pos.symbol, idx);
  const initials = pos.symbol.slice(0, 2);
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: radius, padding: "1.2rem", display: "flex", flexDirection: "column", gap: "0.8rem" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: C.surface2, border: `1.5px solid ${color}33`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: syne, fontWeight: 800, fontSize: 13, color, flexShrink: 0 }}>
            {initials}
          </div>
          <div>
            <div style={{ fontFamily: syne, fontWeight: 700, fontSize: "0.88rem", color: C.text, lineHeight: 1.2 }}>{pos.name}</div>
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 2 }}>{pos.symbol}</div>
          </div>
        </div>
        {/* Risk badge */}
        <div style={{ fontSize: 10, fontFamily: mono, padding: "3px 8px", borderRadius: 6, background: `${riskColor(pos.riskScore)}18`, color: riskColor(pos.riskScore), border: `1px solid ${riskColor(pos.riskScore)}33` }}>
          AI {riskLabel(pos.riskScore)} · {pos.riskScore ?? "?"}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem 1rem" }}>
        {[
          ["Tokens held",  fmtTokens(pos.amount)],
          ["Buy price",    `${pos.buyPrice.toFixed(8)} SOL`],
          ["SOL spent",    `${pos.totalSpentSol.toFixed(2)} SOL`],
          ["Bought at",    fmtTime(pos.boughtAt)],
        ].map(([k, v]) => (
          <div key={k}>
            <div style={{ fontSize: 9, color: C.muted, letterSpacing: "0.09em", textTransform: "uppercase", marginBottom: 2 }}>{k}</div>
            <div style={{ fontSize: 11, fontFamily: mono, color: C.text }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Mint address */}
      <div style={{ fontSize: 9, fontFamily: mono, color: C.muted, background: C.surface2, borderRadius: 6, padding: "4px 8px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {pos.mintAddress}
      </div>

      {/* Bot attribution + auto-trade badge */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: C.green, letterSpacing: "0.06em" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.green, display: "inline-block", boxShadow: `0 0 5px ${C.green}` }} />
          AUTO-TRADED · ALL 4 FILTERS PASSED
        </div>
        {pos.botName && (
          <div style={{
            fontSize: 9, fontFamily: mono, letterSpacing: "0.08em",
            padding: "2px 7px", borderRadius: 5,
            background: `${BOT_COLORS[pos.botName] ?? C.muted}18`,
            color:       BOT_COLORS[pos.botName] ?? C.muted,
            border:     `1px solid ${BOT_COLORS[pos.botName] ?? C.muted}33`,
            textTransform: "uppercase",
          }}>
            Bot {pos.botName}
          </div>
        )}
      </div>
    </div>
  );
}

function TradeLogRow({ event }) {
  const isBuy    = event.action === "BUY";
  const rowColor = isBuy ? C.green : C.muted;
  const botColor = BOT_COLORS[event.botName] ?? C.muted;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "54px 72px 72px 1fr 1fr auto", gap: "0 10px", alignItems: "center", padding: "8px 14px", borderBottom: `1px solid ${C.border}`, fontFamily: mono, fontSize: 11 }}>
      <span style={{ color: rowColor, fontWeight: 700, fontSize: 10, letterSpacing: "0.06em" }}>{isBuy ? "✓ BUY" : "⛔ SKIP"}</span>
      {/* Bot badge */}
      <span style={{
        fontSize: 9, padding: "2px 6px", borderRadius: 4, letterSpacing: "0.07em",
        background: `${botColor}18`, color: botColor, border: `1px solid ${botColor}33`,
        textAlign: "center", textTransform: "uppercase", whiteSpace: "nowrap",
      }}>
        {event.botName ?? "—"}
      </span>
      <span style={{ color: C.gold, letterSpacing: "0.06em" }}>{event.symbol}</span>
      <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {isBuy
          ? `${fmtTokens(event.tokensReceived)} @ ${event.price?.toFixed(8)}`
          : event.reason?.slice(0, 44)}
      </span>
      <span style={{ color: isBuy ? C.green : C.muted, textAlign: "right" }}>
        {isBuy ? `−${event.solSpent} SOL` : ""}
      </span>
      <span style={{ color: C.muted, fontSize: 10, whiteSpace: "nowrap" }}>{fmtTime(event.timestamp)}</span>
    </div>
  );
}

function PulsingDot({ color }) {
  return (
    <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, display: "inline-block", boxShadow: `0 0 6px ${color}`, animation: "cpPulse 2s ease-in-out infinite" }} />
  );
}

function LoadingScreen() {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, fontFamily: mono }}>
      <div style={{ width: 40, height: 40, border: `2px solid ${C.gold}`, borderTopColor: "transparent", borderRadius: "50%", animation: "cpSpin 0.8s linear infinite" }} />
      <div style={{ color: C.muted, fontSize: 13, letterSpacing: "0.1em" }}>Connecting to indexer…</div>
      <div style={{ fontSize: 11, color: "#3A3E4C", letterSpacing: "0.06em" }}>GET /api/wallet · polling every {POLL_MS / 1000}s</div>
    </div>
  );
}

function ErrorScreen({ message }) {
  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, fontFamily: mono }}>
      <div style={{ fontSize: 28 }}>⚠️</div>
      <div style={{ color: C.red, fontSize: 14, letterSpacing: "0.06em" }}>Indexer offline</div>
      <div style={{ color: C.muted, fontSize: 11 }}>{message}</div>
      <div style={{ color: "#3A3E4C", fontSize: 10, maxWidth: 320, textAlign: "center", lineHeight: 1.7 }}>
        Start the backend: <span style={{ color: C.gold }}>npx ts-node src/indexer.ts</span><br/>
        The dashboard auto-reconnects every {POLL_MS / 1000}s.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Root App
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  useFonts();
  const { wallet, error, lastFetch, newTrade } = useWallet();

  // ── Loading / error states ────────────────────────────────────────────────
  if (!wallet && !error) return <LoadingScreen />;
  if (error && !wallet)  return <ErrorScreen message={error} />;

  const { solBalance, startingSOL, tradeCount, positions, tradeLog, lastUpdated } = wallet;
  const totalSpent   = startingSOL - solBalance;
  const totalPct     = ((totalSpent / startingSOL) * 100).toFixed(1);
  const buyEvents    = (tradeLog ?? []).filter(e => e.action === "BUY");
  const blockEvents  = (tradeLog ?? []).filter(e => e.action === "BLOCKED");

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: mono, color: C.text, overflowX: "hidden" }}>
      <style>{`
        @keyframes cpPulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes cpSpin  { to{transform:rotate(360deg)} }
        @keyframes cpFlash { 0%,100%{box-shadow:none} 50%{box-shadow:0 0 0 3px ${C.green}55} }
        @keyframes cpFadeUp{ from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background:#0A0B0F } ::-webkit-scrollbar-thumb { background:#2A2D36; border-radius:99px }
      `}</style>

      {/* ── Header ── */}
      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "1.6rem 2rem 0", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", border: `2px solid ${C.gold}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: syne, fontWeight: 800, fontSize: 15, color: C.gold }}>C</div>
          <span style={{ fontFamily: syne, fontWeight: 800, fontSize: "1.1rem", color: C.text, letterSpacing: "-0.01em" }}>My Coin Portal</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Live / error indicator */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, color: error ? C.red : C.green, letterSpacing: "0.07em" }}>
            <PulsingDot color={error ? C.red : C.green} />
            {error ? "OFFLINE" : "4 BOTS LIVE"}
          </div>
          {lastFetch && (
            <div style={{ fontSize: 10, color: C.muted, letterSpacing: "0.06em" }}>
              synced {fmtTime(lastFetch.toISOString())}
            </div>
          )}
        </div>
      </div>

      {/* ── Hero ── */}
      <div style={{ textAlign: "center", padding: "3.5rem 2rem 2.5rem", animation: "cpFadeUp 0.6s ease both" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, letterSpacing: "0.13em", textTransform: "uppercase", color: C.gold, border: `1px solid ${C.gold}33`, borderRadius: 100, padding: "5px 14px", marginBottom: "1.5rem" }}>
          <PulsingDot color={C.green} />
          4 Autonomous Bots · Alpha · Beta · Gamma · Delta
        </div>
        <div style={{ fontFamily: syne, fontSize: "clamp(2.8rem, 7vw, 5rem)", fontWeight: 800, lineHeight: 0.95, letterSpacing: "-0.03em", marginBottom: "1.2rem" }}>
          <span style={{ display: "block", color: C.text }}>My</span>
          <span style={{ display: "block", color: C.gold }}>Coin</span>
          <span style={{ display: "block", color: C.text }}>Portal</span>
        </div>
        <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.7, maxWidth: 420, margin: "0 auto" }}>
          Four independent bots — Alpha, Beta, Gamma, Delta — run staggered scans every 10–15 seconds. Every trade is AI-verified through the 4-step pipeline before execution.
        </p>
      </div>

      {/* ── Stat bar ── */}
      <div style={{ maxWidth: 1160, margin: "0 auto 1.5rem", padding: "0 2rem" }}>
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", animation: "cpFadeUp 0.7s 0.1s ease both", opacity: 0 }}>
          <StatCard label="SOL Balance"    value={`${solBalance.toFixed(4)}`} sub="fake SOL remaining"     accent={C.gold}  />
          <StatCard label="SOL Deployed"   value={`${totalSpent.toFixed(2)}`} sub={`${totalPct}% of start`} accent={C.green} />
          <StatCard label="Auto-trades"    value={tradeCount}                  sub="lifetime executions"   />
          <StatCard label="Open positions" value={positions.length}            sub="unique tokens held"    accent={positions.length > 0 ? C.green : C.muted} />
          <StatCard label="Blocked"        value={blockEvents.length}          sub="in trade log"          accent={C.muted} />
          <div style={{ flex: 1, minWidth: 240 }}>
            <PnLBar solBalance={solBalance} startingSOL={startingSOL} />
          </div>
        </div>

        {/* Bot status strip */}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
          {[
            { name: "Alpha", interval: "10s" },
            { name: "Beta",  interval: "12s" },
            { name: "Gamma", interval: "13.5s" },
            { name: "Delta", interval: "15s" },
          ].map(b => {
            const col      = BOT_COLORS[b.name] ?? C.muted;
            const botTrades = (tradeLog ?? []).filter(e => e.botName === b.name && e.action === "BUY").length;
            const botBlocks = (tradeLog ?? []).filter(e => e.botName === b.name && e.action === "BLOCKED").length;
            return (
              <div key={b.name} style={{ background: C.surface, border: `1px solid ${col}33`, borderRadius: 10, padding: "0.65rem 1rem", display: "flex", alignItems: "center", gap: 10, flex: "1 1 160px" }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: col, boxShadow: `0 0 6px ${col}`, display: "inline-block", flexShrink: 0 }} />
                <div>
                  <div style={{ fontFamily: syne, fontWeight: 700, fontSize: "0.8rem", color: col }}>Bot {b.name}</div>
                  <div style={{ fontSize: 9, color: C.muted, letterSpacing: "0.07em", marginTop: 2 }}>
                    every {b.interval} · {botTrades} buy{botTrades !== 1 ? "s" : ""} · {botBlocks} skip{botBlocks !== 1 ? "s" : ""}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ maxWidth: 1160, margin: "0 auto", padding: "0 2rem 4rem" }}>

        {/* ── Open Positions ── */}
        <section style={{ marginBottom: "2.5rem" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "1rem" }}>
            <h2 style={{ fontFamily: syne, fontSize: "0.85rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: C.muted, margin: 0 }}>
              Open Positions <span style={{ color: positions.length > 0 ? C.green : C.muted }}>({positions.length})</span>
            </h2>
            <span style={{ fontSize: 10, color: C.muted, letterSpacing: "0.07em" }}>All entries AI-verified</span>
          </div>

          {positions.length === 0 ? (
            <div style={{ background: C.surface, border: `1px dashed ${C.border}`, borderRadius: radius, padding: "2.5rem", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 10 }}>🤖</div>
              <div style={{ color: C.muted, fontSize: 13, letterSpacing: "0.05em" }}>No positions yet — indexer is scanning for opportunities…</div>
              <div style={{ color: "#3A3E4C", fontSize: 11, marginTop: 6 }}>A token must clear all 4 filters before a buy is executed.</div>
            </div>
          ) : (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
              gap: "1rem",
              animation: newTrade ? "cpFlash 2s ease" : "none",
            }}>
              {positions.map((pos, i) => <PositionCard key={pos.mintAddress} pos={pos} idx={i} />)}
            </div>
          )}
        </section>

        {/* ── Trade Log ── */}
        <section>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "1rem" }}>
            <h2 style={{ fontFamily: syne, fontSize: "0.85rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: C.muted, margin: 0 }}>
              Trade Log <span style={{ color: C.muted }}>({(tradeLog ?? []).length})</span>
            </h2>
            <span style={{ fontSize: 10, color: C.muted, letterSpacing: "0.07em" }}>
              {buyEvents.length} executed · {blockEvents.length} blocked · newest first
            </span>
          </div>

          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: radius, overflow: "hidden" }}>
            {/* Column headers */}
            <div style={{ display: "grid", gridTemplateColumns: "54px 72px 72px 1fr 1fr auto", gap: "0 10px", padding: "8px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: C.muted }}>
              <span>Action</span><span>Bot</span><span>Symbol</span><span>Detail</span><span style={{textAlign:"right"}}>Cost</span><span>Time</span>
            </div>

            {(tradeLog ?? []).length === 0 ? (
              <div style={{ padding: "2rem", textAlign: "center", color: C.muted, fontSize: 12 }}>
                No events yet — waiting for first cycle…
              </div>
            ) : (
              <div style={{ maxHeight: 420, overflowY: "auto" }}>
                {(tradeLog ?? []).map((ev, i) => <TradeLogRow key={`${ev.id}-${i}`} event={ev} />)}
              </div>
            )}
          </div>
        </section>

        {/* ── Footer ── */}
        <div style={{ marginTop: "3rem", textAlign: "center", fontSize: 10, letterSpacing: "0.08em", color: "#2A2D36", textTransform: "uppercase", borderTop: `1px solid ${C.border}`, paddingTop: "1.5rem" }}>
          CoinPortal · Autonomous AI trading · Paper money only · Not financial advice
          {lastUpdated && <span style={{ color: "#2A2D36" }}> · Backend updated {fmtTime(lastUpdated)}</span>}
        </div>
      </div>
    </div>
  );
}
