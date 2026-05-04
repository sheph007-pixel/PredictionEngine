import { useState, useEffect, useRef } from 'react';
import { STAGES, STAGE_INDEX, PROCESS_TASKS, PHASES } from './data.js';
import { claudeComplete, claudeChat } from './utils/ai.js';
import { PRECEDENT_BY_ID, PUBLIC_COMP_BANDS } from './data/precedents.js';

const PUBLIC_COMP_BY_TICKER = Object.fromEntries(PUBLIC_COMP_BANDS.comps.map(c => [c.ticker, c]));

// ---------- helpers ----------
function addWeeks(dateStr, weeks) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + weeks * 7);
  return d;
}
function fmtMonthDay(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtMonthYear(d) {
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function projectTaskDates(process) {
  const anchor = PROCESS_TASKS.find(t => t.id === process.currentTaskId);
  const anchorWeeks = anchor.weeksFromStart;
  return PROCESS_TASKS.map(t => ({
    ...t,
    projectedDate: addWeeks(process.currentTaskDate, t.weeksFromStart - anchorWeeks),
  }));
}

export function probabilityFor(buyer) {
  const base = buyer.probability;
  const stageIdx = STAGE_INDEX[buyer.stage];
  const lift = [0.85, 1.0, 1.18, 1.5, 3.0][stageIdx] || 1;
  const raw = Math.min(95, base * lift);
  return Math.round(raw);
}

export function winnerProbabilities(buyers, ebitda = 18, caseMode = "mid") {
  const live = buyers.filter(b => b.stage !== "dropped");
  if (live.length === 0) return { winnerByBuyer: {}, noDealPct: 100, dealClosesPct: 0 };

  const dealClosesProb = 1 - live.reduce((acc, b) => acc * (1 - probabilityFor(b) / 100), 1);
  const dealClosesPct = Math.round(dealClosesProb * 100);
  const noDealPct = 100 - dealClosesPct;

  const STAGE_WEIGHT = [0.4, 0.7, 1.0, 1.6, 2.5];
  const scores = live.map(b => {
    const p = probabilityFor(b) / 100;
    const stageW = STAGE_WEIGHT[STAGE_INDEX[b.stage]] || 1;
    return { buyer: b, score: p * stageW };
  });
  const totalScore = scores.reduce((s, x) => s + x.score, 0) || 1;

  const winnerByBuyer = {};
  let assigned = 0;
  scores.forEach((x, i) => {
    if (i === scores.length - 1) {
      winnerByBuyer[x.buyer.id] = Math.max(0, dealClosesPct - assigned);
    } else {
      const pct = Math.round((x.score / totalScore) * dealClosesPct);
      winnerByBuyer[x.buyer.id] = pct;
      assigned += pct;
    }
  });
  return { winnerByBuyer, noDealPct, dealClosesPct };
}

function winnerDelta(buyer, currentPct) {
  if (buyer.lastWeekWinnerPct == null) return 0;
  return currentPct - buyer.lastWeekWinnerPct;
}

// Pricing model:
//   - Default: every buyer inherits the GLOBAL market band for the active case
//     (low/mid/high). The asset is the same for everyone; only probability
//     varies per buyer.
//   - Override: if buyer.multipleOverride is set (LOI received with a firm
//     price, term sheet, etc.) we use that triple instead. UI surfaces it.
//   - Stage tightening: as deals advance, the range narrows toward the mid.
export function valuationFor(buyer, ebitda = 18, caseMode = "mid", market) {
  const stageIdx = STAGE_INDEX[buyer.stage] ?? 0;
  const tighten = [0.0, 0.25, 0.55, 0.8, 0.95][stageIdx] ?? 0;

  const override = buyer.multipleOverride;
  let baseLow, baseMid, baseHigh;

  if (override) {
    baseLow = override.low;
    baseMid = override.mid;
    baseHigh = override.high;
  } else if (market) {
    // Use the active case's band as base; mid is the band midpoint.
    const band = market[caseMode] || market.mid || { low: 10, high: 13 };
    baseLow = band.low;
    baseHigh = band.high;
    baseMid = (band.low + band.high) / 2;
  } else {
    baseLow = 10; baseMid = 12; baseHigh = 14;
  }

  // Stage tightening — only applies when no override (override is already firm).
  const lo = override ? baseLow : baseMid - (baseMid - baseLow) * (1 - tighten);
  const hi = override ? baseHigh : baseMid + (baseHigh - baseMid) * (1 - tighten);

  const adj = buyer.multipleAdj || 0;
  const multLow = +(lo + adj).toFixed(1);
  const multMid = +(baseMid + adj).toFixed(1);
  const multHigh = +(hi + adj).toFixed(1);
  const headlineMult = caseMode === "conservative" ? multLow : caseMode === "aggressive" ? multHigh : multMid;

  return {
    multLow, multMid, multHigh,
    headlineMult,
    headlineDollar: headlineMult * ebitda,
    dollarLow: multLow * ebitda,
    dollarMid: multMid * ebitda,
    dollarHigh: multHigh * ebitda,
    confidence: Math.round(35 + tighten * 60 + (override ? 25 : 0)),
    source: override ? override.source : 'market-band',
    evidence: override ? override.evidence : null,
  };
}

function quickThesis(thesis, maxChars = 110) {
  if (!thesis) return "";
  const firstSentence = thesis.split(/(?<=[.!?])\s+/)[0] || thesis;
  if (firstSentence.length <= maxChars) return firstSentence;
  return firstSentence.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
}

export function fmtMoney(m) {
  if (m >= 1000) return "$" + (m / 1000).toFixed(2) + "B";
  return "$" + Math.round(m) + "M";
}

function reasoningFor(buyer) {
  const reasons = [];
  if (buyer.fit.benefits >= 4) reasons.push({ kind: "+", text: "High benefits-vertical alignment" });
  if (buyer.fit.size >= 4) reasons.push({ kind: "+", text: "Capital base supports bid at market clear" });
  if (buyer.fit.precedent >= 4) reasons.push({ kind: "+", text: "Active 2025-26 M&A precedent" });
  if (buyer.fit.benefits <= 2) reasons.push({ kind: "−", text: "Limited benefits focus" });
  if (buyer.fit.size <= 2) reasons.push({ kind: "−", text: "Capacity constraint at our scale" });
  if (buyer.flags?.includes("Declined 2x informally")) reasons.push({ kind: "−", text: "Two prior informal passes" });
  if (buyer.flags?.includes("Stock pressure")) reasons.push({ kind: "−", text: "Public-equity headwinds" });
  if (buyer.stage === "chemistry") reasons.push({ kind: "+", text: "Chemistry meeting on calendar" });
  if (buyer.stage === "loi") reasons.push({ kind: "+", text: "LOI received" });
  return reasons.slice(0, 4);
}

// ---------- hero KPIs ----------
function HeroRationale({ text }) {
  if (!text) return (
    <div className="hero-kpi-why hero-kpi-why-empty">
      <span className="hero-kpi-why-tag">AI</span>
      <span className="hero-kpi-why-text">Re-scan to generate Reagan's defense of this number.</span>
    </div>
  );
  return (
    <div className="hero-kpi-why">
      <span className="hero-kpi-why-tag">Reagan · AI</span>
      <span className="hero-kpi-why-text" title={text}>{text}</span>
    </div>
  );
}

export function HeroKPIs({ buyers, process, ebitda, caseMode, market, rationales }) {
  const currentIdx = PROCESS_TASKS.findIndex(t => t.id === process.currentTaskId);
  const currentTask = PROCESS_TASKS[currentIdx];
  const closeTask = PROCESS_TASKS[PROCESS_TASKS.length - 1];
  const today = new Date();
  const weeksToClose = closeTask.weeksFromStart - currentTask.weeksFromStart;
  const projectedClose = new Date(today);
  projectedClose.setDate(projectedClose.getDate() + weeksToClose * 7);

  const { dealClosesPct } = winnerProbabilities(buyers, ebitda, caseMode);
  const confLevel = dealClosesPct >= 85 ? "High" : dealClosesPct >= 65 ? "Solid" : dealClosesPct >= 40 ? "Moderate" : "Low";

  const m = (market && market[caseMode]) || { low: 11, high: 13, label: "Realistic" };
  const clearLow = ebitda * m.low;
  const clearHigh = ebitda * m.high;
  const clearMid = ebitda * ((m.low + m.high) / 2);

  return (
    <div className="hero">
      <div className="hero-kpi">
        <div className="hero-kpi-label">Projected close</div>
        <div className="hero-kpi-value hero-kpi-close">{fmtMonthYear(projectedClose)}</div>
        <div className="hero-kpi-foot"><b>{weeksToClose}</b> weeks remaining · currently in <b>{currentTask.phase}</b></div>
        <HeroRationale text={rationales?.close_date} />
      </div>
      <div className="hero-kpi">
        <div className="hero-kpi-label">Deal confidence</div>
        <div className="hero-kpi-value hero-kpi-confidence">{dealClosesPct}<span>%</span></div>
        <div className="hero-kpi-foot"><b>{confLevel}</b> probability any deal closes</div>
        <HeroRationale text={rationales?.confidence} />
      </div>
      <div className="hero-kpi">
        <div className="hero-kpi-label">Market clearing price <span className="hero-kpi-case">· {m.label}</span></div>
        <div className="hero-kpi-value hero-kpi-pipeline hero-kpi-range">
          <span className="hero-range-low">{fmtMoney(clearLow)}</span>
          <span className="hero-range-sep">to</span>
          <span className="hero-range-high">{fmtMoney(clearHigh)}</span>
        </div>
        <div className="hero-kpi-foot">${ebitda}M EBITDA × <b>{m.low.toFixed(1)}–{m.high.toFixed(1)}×</b> · midpoint <b>{fmtMoney(clearMid)}</b></div>
        <HeroRationale text={rationales?.clearing_price} />
      </div>
    </div>
  );
}

export function ContributionChart({ buyers, ebitda, caseMode, market, onSelect }) {
  const live = buyers.filter(b => b.stage !== "dropped");
  const { winnerByBuyer, noDealPct, dealClosesPct } = winnerProbabilities(buyers, ebitda, caseMode);

  const rows = live.map(b => {
    const v = valuationFor(b, ebitda, caseMode, market);
    const winner = winnerByBuyer[b.id] || 0;
    const delta = winnerDelta(b, winner);
    return { buyer: b, winner, delta, deal: v.headlineDollar, dollarLow: v.dollarLow, dollarHigh: v.dollarHigh };
  }).sort((a, b) => b.winner - a.winner);

  const max = Math.max(...rows.map(r => r.winner), noDealPct, 1);

  return (
    <div className="contrib">
      <div className="contrib-head">
        <div>
          <div className="contrib-title">Most likely closer</div>
          <div className="contrib-sub">AI prediction · who we end up closing with</div>
        </div>
      </div>
      <div className="contrib-list">
        {rows.map(({ buyer, winner, delta, deal, dollarLow, dollarHigh }) => {
          const pct = (winner / max) * 100;
          return (
            <div key={buyer.id} className="contrib-row" onClick={() => onSelect(buyer.id)}>
              <div className="contrib-name">{buyer.name}</div>
              <div className="contrib-bar-wrap">
                <div className="contrib-bar" style={{ width: pct + "%" }}>
                  <div className="contrib-bar-inner"></div>
                </div>
                <div className="contrib-bar-pct">{winner}%</div>
              </div>
              <div className="contrib-meta">
                <span className="contrib-deal-label">at</span>
                <span className="contrib-deal">{fmtMoney(deal)}</span>
                <span className="contrib-deal-range">({fmtMoney(dollarLow)}–{fmtMoney(dollarHigh)})</span>
              </div>
            </div>
          );
        })}
        <div className="contrib-row contrib-row-nodeal">
          <div className="contrib-name contrib-name-nodeal">No deal</div>
          <div className="contrib-bar-wrap">
            <div className="contrib-bar contrib-bar-nodeal" style={{ width: ((noDealPct / max) * 100) + "%" }}></div>
            <div className="contrib-bar-pct">{noDealPct}%</div>
          </div>
          <div className="contrib-meta contrib-meta-nodeal">process fails to clear · we walk</div>
        </div>
      </div>
    </div>
  );
}

// ---------- process tracker ----------
export function ProcessTracker({ process, onUpdate, buyers = [], ebitda = 18, caseMode = "mid" }) {
  const [collapsed, setCollapsed] = useState(true);
  const currentIdx = PROCESS_TASKS.findIndex(t => t.id === process.currentTaskId);
  const currentTask = PROCESS_TASKS[currentIdx];
  const totalTasks = PROCESS_TASKS.length;
  const pctDone = Math.round(((currentIdx) / (totalTasks - 1)) * 100);
  const phaseIdx = PHASES.indexOf(currentTask.phase);

  return (
    <div className={"process process-thin" + (collapsed ? " process-collapsed" : "")}>
      <div className="process-thin-head" onClick={() => setCollapsed(!collapsed)}>
        <div className="process-thin-left">
          <div className="process-eyebrow">Process · Reagan Consulting</div>
          <div className="process-thin-title">
            <span className="process-thin-phase">Phase {phaseIdx + 1}/{PHASES.length} · {currentTask.phase}</span>
            <span className="process-thin-task">{currentTask.label}</span>
          </div>
        </div>
        <div className="process-thin-right">
          <div className="process-thin-progress">
            <div className="process-thin-bar">
              <div className="process-thin-fill" style={{ width: pctDone + "%" }}></div>
            </div>
            <div className="process-thin-pct">{pctDone}%</div>
          </div>
          <button className="process-collapse" onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{transform: collapsed ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s"}}>
              <polyline points="18 15 12 9 6 15"/>
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="process-rail">
          {PHASES.map((phase) => {
            const phaseTasks = PROCESS_TASKS.filter(t => t.phase === phase);
            return (
              <div key={phase} className="process-phase">
                <div className="process-phase-label">{phase}</div>
                <div className="process-phase-tasks">
                  {phaseTasks.map(t => {
                    const idx = PROCESS_TASKS.findIndex(x => x.id === t.id);
                    const state = idx < currentIdx ? "done" : idx === currentIdx ? "active" : "future";
                    return (
                      <div
                        key={t.id}
                        className={"process-task process-task-" + state}
                        onClick={() => onUpdate({ ...process, currentTaskId: t.id })}
                        title={"Mark " + t.label + " as current step"}
                      >
                        <div className="process-task-dot"></div>
                        <div className="process-task-label">{t.label}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const MARKET_MULTIPLES_SEED = {
  conservative: { low: 8.5, high: 10.5, label: "Conservative", note: "Bear case · soft market" },
  mid: { low: 11.0, high: 13.0, label: "Realistic", note: "Base case · current signals" },
  aggressive: { low: 13.5, high: 15.5, label: "Aggressive", note: "Bull case · strategic premium" },
};

// ---------- system bar ----------
export function SystemBar({ ebitda, onEbitda, caseMode, onCase, market, marketMeta, onRescan, rescanError }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(ebitda));
  const [refreshing, setRefreshing] = useState(false);
  const [localErr, setLocalErr] = useState(null);
  useEffect(() => setDraft(String(ebitda)), [ebitda]);

  const mult = market || MARKET_MULTIPLES_SEED;
  const cases = ["conservative", "mid", "aggressive"];

  const commit = () => {
    const n = parseFloat(draft);
    if (!isNaN(n) && n > 0) onEbitda(n);
    else setDraft(String(ebitda));
    setEditing(false);
  };

  const rescan = async () => {
    if (refreshing || !onRescan) return;
    setRefreshing(true);
    setLocalErr(null);
    try {
      await onRescan();
    } catch (e) {
      setLocalErr(e.message || 'Re-scan failed');
    } finally {
      setRefreshing(false);
    }
  };

  const errorMsg = localErr || rescanError;

  return (
    <div className="sysbar">
      <div className="sysbar-cases" role="group" aria-label="Case">
        {cases.map(c => {
          const m = mult[c];
          return (
            <button
              key={c}
              className={"sysbar-case" + (caseMode === c ? " on" : "")}
              onClick={() => onCase(c)}
              title={`${m.note} · ${m.low.toFixed(1)}–${m.high.toFixed(1)}× · ${fmtMoney(m.low * ebitda)}–${fmtMoney(m.high * ebitda)}`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <div className="sysbar-divider"></div>
      <div className="sysbar-ebitda">
        <span className="sysbar-key">EBITDA</span>
        {editing ? (
          <span className="sysbar-edit">
            <span>$</span>
            <input
              autoFocus
              type="number"
              step="0.5"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(String(ebitda)); setEditing(false); } }}
            />
            <span>M</span>
          </span>
        ) : (
          <span className="sysbar-value" onClick={() => setEditing(true)} title="Click to edit (per Reagan)">${ebitda}M</span>
        )}
      </div>
      <div className="sysbar-divider"></div>
      <button
        className={"sysbar-rescan" + (refreshing ? " refreshing" : "") + (errorMsg ? " err" : "")}
        onClick={rescan}
        disabled={refreshing}
        title={errorMsg ? `Re-scan failed: ${errorMsg}` : (marketMeta || "Re-score every buyer + market bands using AI on full evidence (notes, docs, prior reasoning)")}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        {refreshing ? "Re-scanning…" : errorMsg ? "Retry re-scan" : "Re-scan"}
      </button>
      <div className="sysbar-live" title={marketMeta || "Last AI re-scan"}>
        <span className={"live-dot" + (errorMsg ? " live-dot-err" : "")}></span>
      </div>
    </div>
  );
}

export function ValuationBar({ ebitda, onEbitda, caseMode, onCase, market, marketMeta, onRefreshMarket }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(ebitda));
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setDraft(String(ebitda)), [ebitda]);

  const mult = market || MARKET_MULTIPLES_SEED;
  const cases = ["conservative", "mid", "aggressive"];

  const commit = () => {
    const n = parseFloat(draft);
    if (!isNaN(n) && n > 0) onEbitda(n);
    else setDraft(String(ebitda));
    setEditing(false);
  };

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    await new Promise(r => setTimeout(r, 1400));
    onRefreshMarket && onRefreshMarket();
    setRefreshing(false);
  };

  return (
    <div className="valbar valbar-compact">
      <div className="valbar-strip-item">
        <span className="valbar-strip-key">EBITDA</span>
        {editing ? (
          <span className="valbar-strip-edit">
            <span>$</span>
            <input
              autoFocus
              type="number"
              step="0.5"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(String(ebitda)); setEditing(false); } }}
            />
            <span>M</span>
          </span>
        ) : (
          <span className="valbar-strip-value" onClick={() => setEditing(true)}>${ebitda}M</span>
        )}
        <span className="valbar-strip-source">per Reagan</span>
      </div>
      <div className="valbar-strip-divider"></div>
      <div className="valbar-strip-item">
        <span className="valbar-strip-key">Multiple</span>
        <div className="valbar-strip-cases">
          {cases.map(c => {
            const m = mult[c];
            return (
              <button
                key={c}
                className={"valbar-strip-case" + (caseMode === c ? " on" : "")}
                onClick={() => onCase(c)}
                title={`${m.note} · ${m.low}–${m.high}× · ${fmtMoney(m.low * ebitda)}–${fmtMoney(m.high * ebitda)}`}
              >
                <span>{m.label}</span>
                <span className="valbar-strip-case-mult">{m.low.toFixed(1)}–{m.high.toFixed(1)}×</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="valbar-strip-spacer"></div>
      <button className={"valbar-refresh" + (refreshing ? " refreshing" : "")} onClick={refresh} disabled={refreshing}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <polyline points="1 20 1 14 7 14"/>
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
        </svg>
        {refreshing ? "Re-scanning…" : "Re-scan market"}
      </button>
      <span className="valbar-strip-source valbar-strip-source-meta">{marketMeta || "AI · sector deal flow + public comp drift · 2 min ago"}</span>
    </div>
  );
}

// ---------- pipeline summary ----------
export function PipelineStats({ buyers, ebitda, caseMode, market, process }) {
  const active = buyers.filter(b => b.stage !== "dropped" && b.stage !== "closed");
  const dropped = buyers.filter(b => b.stage === "dropped").length;
  const counts = STAGES.map(s => ({ ...s, count: buyers.filter(b => b.stage === s.id).length }));
  const totalLive = buyers.filter(b => b.stage !== "dropped").length || 1;
  const live = buyers.filter(b => b.stage !== "dropped");
  const top = [...live].sort((a, b) => probabilityFor(b) - probabilityFor(a))[0];
  const expectedClear = live.reduce((sum, b) => {
    const v = valuationFor(b, ebitda, caseMode, market);
    return sum + (probabilityFor(b) / 100) * v.headlineDollar;
  }, 0);
  const topV = top ? valuationFor(top, ebitda, caseMode, market) : null;
  const advanced = buyers.filter(b => STAGE_INDEX[b.stage] >= STAGE_INDEX.nda && b.stage !== "dropped").length;

  return (
    <div className="stats stats-4">
      <div className="stat">
        <div className="stat-label">Active buyers</div>
        <div className="stat-value">{active.length}<span className="stat-sub">/ {buyers.length}</span></div>
        <div className="stat-sub2-muted">{dropped} dropped</div>
        <div className="stage-distribution">
          <div className="dist-bar">
            {counts.map((s, i) => {
              const pct = (s.count / totalLive) * 100;
              if (s.count === 0) return null;
              return (
                <div key={s.id} className={"dist-seg dist-seg-" + i} style={{ width: pct + "%" }} title={`${s.label}: ${s.count}`}></div>
              );
            })}
          </div>
          <div className="dist-legend">
            {counts.map(s => (
              <div key={s.id} className={"dist-legend-item" + (s.count === 0 ? " dist-zero" : "")}>
                <span className="dist-legend-label">{s.short}</span>
                <span className="dist-legend-count">{s.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="stat">
        <div className="stat-label">AI lead</div>
        <div className="stat-value stat-value-sm">{top ? top.name : "—"}</div>
        <div className="stat-sub2">{top ? probabilityFor(top) : 0}% probability</div>
        <div className="stat-sub2-muted">{topV ? fmtMoney(topV.headlineDollar) : "—"} expected value</div>
      </div>
      <div className="stat stat-emphasis">
        <div className="stat-label">Pipeline expected value</div>
        <div className="stat-value">{fmtMoney(expectedClear)}</div>
        <div className="stat-sub2-muted">sum of (probability × deal value) across all live buyers</div>
      </div>
      <div className="stat">
        <div className="stat-label">Process momentum</div>
        <div className="stat-value">{advanced}<span className="stat-sub">past outreach</span></div>
        <div className="stat-sub2-muted">{active.length - advanced} still in outreach · {buyers.filter(b => b.stage === "loi").length} at LOI</div>
      </div>
    </div>
  );
}

// ---------- add buyer form ----------
export function AddBuyerForm({ onAdd, onCancel, existingBuyers }) {
  const [name, setName] = useState("");
  const [hq, setHq] = useState("");
  const [revenue, setRevenue] = useState("");
  const [ownership, setOwnership] = useState("PE-backed");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    if (!name.trim() || pending) return;
    setPending(true);
    setError(null);

    const sys = `You are an M&A analyst building a buyer profile for the Kennion Benefits Program sale (advised by Reagan Consulting). The user is adding a new prospective acquirer to the pipeline. Pricing comes from the global industry band — DO NOT generate a per-buyer multiple. Return ONLY a JSON object — no markdown, no commentary — with this exact shape:
{
  "headcount": "string e.g. 5,000-7,000",
  "offices": "string e.g. 200+ or —",
  "sponsor": "string PE sponsor name OR — if not PE-backed",
  "type": "string e.g. National consolidator | Regional broker | Specialty",
  "thesis": "1-2 sentence fit thesis specific to a benefits-program acquisition",
  "fit": { "size": 1-5, "benefits": 1-5, "pe": 0 or 1, "precedent": 1-5 }
}
Be realistic. Match the format of existing peers in the pipeline.`;

    const prompt = `${sys}\n\nNew buyer:\nName: ${name}\nHQ: ${hq || "unknown"}\nRevenue: ${revenue || "unknown"}\nOwnership: ${ownership}\n\nReturn JSON only.`;

    try {
      let reply = await claudeComplete(prompt);
      reply = reply.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      const data = JSON.parse(reply);
      const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) + "-" + Math.random().toString(36).slice(2, 5);
      onAdd({
        id,
        rank: 99,
        name: name.trim(),
        hq: hq.trim() || "—",
        revenue: revenue.trim() || "—",
        headcount: data.headcount || "—",
        offices: data.offices || "—",
        ownership,
        sponsor: data.sponsor || "—",
        type: data.type || "Buyer",
        stage: "outreach",
        notes: "",
        flags: [],
        fit: data.fit || { size: 3, benefits: 3, pe: 3, precedent: 3 },
        multipleOverride: null,
        thesis: data.thesis || "Profile under construction.",
        probability: 12,
        aiGenerated: true,
      });
    } catch (e) {
      setError("AI couldn't build the profile. Try again.");
      setPending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal-add" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onCancel}>×</button>
        <div className="modal-eyebrow">Add to pipeline</div>
        <div className="modal-title" style={{ fontSize: 32, marginBottom: 6 }}>New buyer group</div>
        <div className="modal-sub" style={{ marginBottom: 20 }}>AI builds the full profile — fit thesis, scores, multiple range — so the new entry matches every other row.</div>

        <div className="add-form">
          <div className="add-field">
            <label>Buyer name *</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. AssuredPartners" autoFocus disabled={pending} />
          </div>
          <div className="add-row">
            <div className="add-field">
              <label>Headquarters</label>
              <input type="text" value={hq} onChange={(e) => setHq(e.target.value)} placeholder="e.g. Lake Mary, FL" disabled={pending} />
            </div>
            <div className="add-field">
              <label>Revenue (approx.)</label>
              <input type="text" value={revenue} onChange={(e) => setRevenue(e.target.value)} placeholder="e.g. $2.5B" disabled={pending} />
            </div>
          </div>
          <div className="add-field">
            <label>Ownership</label>
            <div className="add-radio-group">
              {["PE-backed", "Private", "Public", "Mutual"].map(o => (
                <label key={o} className={"add-radio" + (ownership === o ? " on" : "")}>
                  <input type="radio" name="ownership" value={o} checked={ownership === o} onChange={() => setOwnership(o)} disabled={pending} />
                  <span>{o}</span>
                </label>
              ))}
            </div>
          </div>
          {error && <div className="add-error">{error}</div>}
          <div className="add-actions">
            <button className="btn-ghost" onClick={onCancel} disabled={pending}>Cancel</button>
            <button className="btn" onClick={submit} disabled={pending || !name.trim()}>
              {pending ? "AI building profile…" : "Add & analyze"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- buyer row ----------
export function BuyerRow({ buyer, selected, onSelect, onAdvance, onDrop, displayRank, winnerPct }) {
  const stageIdx = STAGE_INDEX[buyer.stage];
  const isDropped = buyer.stage === "dropped";
  const showProb = isDropped ? 0 : (winnerPct ?? probabilityFor(buyer));

  return (
    <div className={"row" + (selected ? " row-selected" : "") + (isDropped ? " row-passed" : "")} onClick={onSelect}>
      <div className="row-rank">{isDropped ? "—" : String(displayRank).padStart(2, "0")}</div>
      <div className="row-name">
        <div className="row-name-main">
          {buyer.website ? (
            <a
              className="row-name-link"
              href={buyer.website}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {buyer.name}
            </a>
          ) : buyer.name}
        </div>
        {!isDropped && buyer.thesis && (
          <div className="row-name-thesis">{quickThesis(buyer.thesis)}</div>
        )}
      </div>
      <div className="row-stages">
        {STAGES.map((s, i) => (
          <div key={s.id} className={"stage-pip" + (i <= stageIdx && !isDropped ? " stage-pip-on" : "")}>
            <span className="stage-pip-label">{s.short}</span>
          </div>
        ))}
      </div>
      <div className="row-prob">
        <div className="prob-bar">
          <div className="prob-bar-fill" style={{ width: showProb + "%" }}></div>
        </div>
        <div className="prob-num">{isDropped ? "—" : showProb}<span>{isDropped ? "" : "%"}</span></div>
      </div>
      <div className="row-actions" onClick={(e) => e.stopPropagation()}>
        {buyer.stage !== "closed" && !isDropped && (
          <>
            <button className="row-action row-action-advance" onClick={() => onAdvance(buyer.id)} title="Advance to next stage">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
            </button>
            <button className="row-action row-action-drop" onClick={() => onDrop(buyer.id)} title="Drop from process">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- source verification ----------
function SourceChip({ source, docs }) {
  if (!source) return <span className="src-chip src-chip-unverified">Unverified — no source on file</span>;
  if (source.kind === 'url') return (
    <a className="src-chip src-chip-url" href={source.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      {source.label || source.url} ↗
    </a>
  );
  if (source.kind === 'file') {
    const doc = docs?.find(d => d.id === source.file_id);
    return <span className="src-chip src-chip-file" title={doc?.classification?.title || ''}>{doc?.filename || source.label}</span>;
  }
  if (source.kind === 'manual') return <span className="src-chip src-chip-manual" title={source.note || ''}>{source.label}</span>;
  if (source.kind === 'ai_inferred') return <span className="src-chip src-chip-unverified">AI inferred — verify</span>;
  return null;
}

function SourceRow({ field, value, source, docs, onAddSource }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isPlaceholder = !source || (source.kind === 'manual' && !source.url && !source.file_id);

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    let host;
    try { host = new URL(trimmed).hostname; } catch { return; }
    onAddSource({ kind: 'url', label: host, url: trimmed });
    setEditing(false);
    setDraft('');
  };

  return (
    <div className="source-row">
      <div className="source-row-head">
        <span className="source-row-field">{field}</span>
        <span className="source-row-value">{value}</span>
      </div>
      <div className="source-row-body">
        <SourceChip source={source} docs={docs} />
        {source?.verified_at && (
          <span className="source-row-meta">
            Verified {new Date(source.verified_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}{source.verified_by ? ` · ${source.verified_by}` : ''}
          </span>
        )}
        {isPlaceholder && !editing && (
          <button className="source-row-add" onClick={() => setEditing(true)}>+ add URL</button>
        )}
        {editing && (
          <div className="source-row-edit">
            <input
              autoFocus
              type="url"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="https://…"
              onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setEditing(false); setDraft(''); } }}
            />
            <button className="btn-mini" onClick={save}>Save</button>
            <button className="btn-mini" onClick={() => { setEditing(false); setDraft(''); }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- buyer modal ----------
export function BuyerModal({ buyer, onClose, onAdvance, onDrop, onDelete, onUpdateNotes, onRescanBuyer }) {
  if (!buyer) return null;
  const isDropped = buyer.stage === "dropped";
  const prob = isDropped ? 0 : probabilityFor(buyer);
  const reasons = reasoningFor(buyer);
  const [draft, setDraft] = useState(buyer.notes);
  const [pending, setPending] = useState(false);
  const [aiInsight, setAiInsight] = useState(null);
  const [aiError, setAiError] = useState(null);
  useEffect(() => { setDraft(buyer.notes); setAiInsight(null); setAiError(null); }, [buyer.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Submit field intel and trigger a real per-buyer rescan. The note is
  // persisted first so the rescan reads the freshest version. The AI's
  // reasoning + citations come back inline; numeric updates apply globally.
  const submitNotes = async () => {
    if (!draft.trim() || pending) return;
    setPending(true);
    setAiError(null);
    onUpdateNotes(buyer.id, draft);
    if (!onRescanBuyer) {
      setAiInsight("→ Re-scan unavailable — note saved.");
      setPending(false);
      return;
    }
    try {
      const result = await onRescanBuyer(buyer.id);
      const updated = result?.buyers?.[0];
      setAiInsight(updated?.reasoning || result?.summary || "→ Re-scored.");
    } catch (e) {
      setAiError(e.message || "Re-scan failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-compact" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>×</button>

        <div className="modal-head modal-head-compact">
          <div>
            <div className="modal-eyebrow">Buyer · {buyer.type}</div>
            <div className="modal-title">
              {buyer.website ? (
                <a
                  className="modal-title-link"
                  href={buyer.website}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {buyer.name}
                </a>
              ) : buyer.name}
            </div>
            <div className="modal-sub">Rev {buyer.revenue} · {buyer.headcount} hc · {buyer.offices} offices</div>
          </div>
          <div className="modal-head-actions">
            {buyer.stage !== "closed" && !isDropped && (
              <button className="btn" onClick={() => onAdvance(buyer.id)}>Advance →</button>
            )}
            {!isDropped && buyer.stage !== "closed" && (
              <button className="btn-ghost" onClick={() => onDrop(buyer.id)}>Drop</button>
            )}
            {onDelete && (
              <button className="btn-ghost btn-danger" onClick={() => onDelete(buyer.id)} title="Permanently delete from pipeline">Delete</button>
            )}
          </div>
        </div>

        <div className="modal-grid">
          <div className="modal-card modal-card-prob">
            <div className="modal-card-label">AI probability of close</div>
            <div className="modal-prob-row">
              <div className="modal-prob-num">{prob}<span>%</span></div>
              <div className="modal-prob-bar">
                <div className="modal-prob-bar-fill" style={{ width: prob + "%" }}></div>
              </div>
            </div>
            <div className="reason-list">
              {reasons.slice(0, 3).map((r, i) => (
                <div key={i} className={"reason " + (r.kind === "+" ? "reason-pos" : "reason-neg")}>
                  <span className="reason-mark">{r.kind}</span>
                  <span>{r.text}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="modal-col">
            <div className="modal-card modal-card-stage">
              <div className="modal-card-label">Stage</div>
              <div className="stage-track">
                {STAGES.map((s, i) => (
                  <div key={s.id} className={"stage-track-step" + (!isDropped && i <= STAGE_INDEX[buyer.stage] ? " on" : "")}>
                    <div className="stage-track-dot"></div>
                    <div className="stage-track-label">{s.label}</div>
                  </div>
                ))}
              </div>
              {isDropped && <div className="dropped-banner">Dropped from process</div>}
            </div>

            <div className="modal-card modal-card-notes">
              <div className="modal-card-label">
                Notes & field intelligence
                <span className="modal-card-hint">AI re-analyzes on submit</span>
              </div>
              <textarea
                className="notes-area"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                placeholder="Log buyer feedback, market signals, chemistry takeaways…"
                disabled={pending}
              />
              <div className="notes-actions">
                <button
                  className="btn btn-submit"
                  onClick={submitNotes}
                  disabled={pending || !draft.trim() || draft === buyer.notes}
                >
                  {pending ? "Analyzing…" : "Submit & re-analyze"}
                </button>
              </div>
              {aiInsight && (
                <div className="notes-insight">
                  <div className="notes-insight-tag">AI · re-scored</div>
                  <div className="notes-insight-text">{aiInsight}</div>
                  {Array.isArray(buyer.aiCitations) && buyer.aiCitations.length > 0 && (
                    <div className="notes-insight-cites">
                      {buyer.aiCitations.slice(0, 4).map((c, i) => (
                        <span key={i} className="notes-insight-cite">{c}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {aiError && (
                <div className="notes-insight notes-insight-err">
                  <div className="notes-insight-tag">Re-scan failed</div>
                  <div className="notes-insight-text">{aiError}</div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <div className="modal-foot-thesis">
            <span className="modal-foot-label">Fit thesis</span>
            <span>{buyer.thesis}</span>
          </div>
          {buyer.flags?.length > 0 && (
            <div className="modal-foot-flags">
              {buyer.flags.map((f, i) => <div key={i} className="flag">{f}</div>)}
            </div>
          )}
          {buyer.lastAnalyzed && (
            <div className="modal-foot-meta">
              AI re-scored {new Date(buyer.lastAnalyzed).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- AI Engine ----------
const CHAT_STORAGE_KEY = "kennion.chat.v2";
const VALID_STAGES = ["outreach", "nda", "chemistry", "loi", "closed", "dropped"];

const AI_TOOLS = [
  {
    name: "set_buyer_stage",
    description: "Move a single buyer to a specific stage in the deal pipeline. Use this when the user asks to advance, drop, or otherwise change a buyer's stage.",
    input_schema: {
      type: "object",
      properties: {
        buyer_id: { type: "string", description: "The buyer's id (lowercase short id like 'hub', 'onedigital')." },
        stage: { type: "string", enum: VALID_STAGES, description: "Target stage." },
      },
      required: ["buyer_id", "stage"],
    },
  },
  {
    name: "set_all_buyers_stage",
    description: "Bulk operation: set every live (non-dropped) buyer's stage. Use only for explicit bulk updates like 'set all buyers to outreach' or 'reset all to NDA'.",
    input_schema: {
      type: "object",
      properties: {
        stage: { type: "string", enum: VALID_STAGES, description: "Stage to apply to all live buyers." },
      },
      required: ["stage"],
    },
  },
  {
    name: "add_buyer_note",
    description: "Append a note to a buyer's notes field. Use when the user is logging field intelligence or feedback about a specific buyer.",
    input_schema: {
      type: "object",
      properties: {
        buyer_id: { type: "string" },
        note: { type: "string", description: "The note text to append." },
      },
      required: ["buyer_id", "note"],
    },
  },
  {
    name: "update_probability",
    description: "Override a buyer's base probability percentage (1-95). Use when the user provides intel that materially changes likelihood of close.",
    input_schema: {
      type: "object",
      properties: {
        buyer_id: { type: "string" },
        probability: { type: "number", description: "New base probability, 1-95." },
      },
      required: ["buyer_id", "probability"],
    },
  },
];

export function AIChat({ buyers, setBuyers, fileIds, open, onToggle, alwaysOpen }) {
  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem(CHAT_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const scrollRef = useRef(null);
  const fileRef = useRef(null);
  const buyersRef = useRef(buyers);
  buyersRef.current = buyers;

  useEffect(() => {
    try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(messages)); } catch {}
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending, open]);

  const clearChat = () => {
    if (messages.length === 0) return;
    if (!window.confirm("Clear chat history?")) return;
    setMessages([]);
  };

  // Execute a tool call on local state. Returns a string describing the result.
  const executeTool = (name, input) => {
    const current = buyersRef.current;
    if (name === "set_buyer_stage") {
      const target = current.find(b => b.id === input.buyer_id);
      if (!target) return `error: no buyer with id "${input.buyer_id}". valid ids: ${current.map(b => b.id).join(", ")}`;
      if (!VALID_STAGES.includes(input.stage)) return `error: invalid stage "${input.stage}"`;
      setBuyers(bs => bs.map(b => b.id === input.buyer_id ? { ...b, stage: input.stage } : b));
      return `ok: ${target.name} → ${input.stage}`;
    }
    if (name === "set_all_buyers_stage") {
      if (!VALID_STAGES.includes(input.stage)) return `error: invalid stage "${input.stage}"`;
      const count = current.filter(b => b.stage !== "dropped").length;
      setBuyers(bs => bs.map(b => b.stage === "dropped" ? b : { ...b, stage: input.stage }));
      return `ok: ${count} live buyers set to ${input.stage}`;
    }
    if (name === "add_buyer_note") {
      const target = current.find(b => b.id === input.buyer_id);
      if (!target) return `error: no buyer with id "${input.buyer_id}"`;
      const stamped = `[${new Date().toISOString().slice(0,10)}] ${input.note}`;
      const next = target.notes ? `${target.notes}\n${stamped}` : stamped;
      setBuyers(bs => bs.map(b => b.id === input.buyer_id ? { ...b, notes: next } : b));
      return `ok: note added to ${target.name}`;
    }
    if (name === "update_probability") {
      const target = current.find(b => b.id === input.buyer_id);
      if (!target) return `error: no buyer with id "${input.buyer_id}"`;
      const p = Math.max(1, Math.min(95, Math.round(input.probability)));
      setBuyers(bs => bs.map(b => b.id === input.buyer_id ? { ...b, probability: p } : b));
      return `ok: ${target.name} probability ${target.probability}% → ${p}%`;
    }
    return `error: unknown tool "${name}"`;
  };

  const buildSystem = () => {
    const ranked = [...buyersRef.current].sort((a, b) => probabilityFor(b) - probabilityFor(a));
    const ctx = ranked.map(b => `- id="${b.id}" · ${b.name} (${b.hq}, ${b.revenue}, ${b.ownership}${b.sponsor !== "—" ? "/" + b.sponsor : ""}, stage=${b.stage}, p=${probabilityFor(b)}%) — ${b.thesis}`).join("\n");
    const docNote = fileIds && fileIds.length > 0
      ? `\n\nThe user has uploaded ${fileIds.length} document${fileIds.length === 1 ? '' : 's'} to the library (CIM, LOIs, buyer emails, analysis, etc.) which are attached to this conversation. Reference them when relevant — quote specifics, cite which doc.`
      : '';
    return `You are the AI analyst inside the Kennion Prediction Engine — a private deal-tracking workspace for Kennion's sale of its Benefits Program, advised by Reagan Consulting. Be concise, opinionated, and specific. Reference buyers by name. Keep text responses under 90 words. No headers, no markdown.

You have tools to mutate the pipeline state. When the user asks you to update, advance, drop, set stages, log notes, or change probabilities — actually call the tools instead of just describing what you would do. After tool calls succeed, briefly confirm what changed.

Stages, in order: outreach → nda → chemistry → loi → closed. "dropped" is the kill state.

Current pipeline (use these exact buyer ids when calling tools):
${ctx}${docNote}`;
  };

  const send = async (presetQ) => {
    const q = (presetQ ?? input).trim();
    if ((!q && attachments.length === 0) || pending) return;
    const sentAttachments = attachments;
    setInput("");
    setAttachments([]);

    const userText = q + (sentAttachments.length ? `\n\n[attached: ${sentAttachments.map(a => a.name).join(", ")}]` : "");
    const userMsg = { role: "user", content: [{ type: "text", text: userText || "(uploaded files for the engine to ingest)" }] };

    let history = [...messages, userMsg];
    setMessages(history);
    setPending(true);

    const system = buildSystem();
    try {
      // Tool-use loop: keep calling until model returns a non-tool stop_reason.
      for (let i = 0; i < 6; i++) {
        const apiMessages = history.map(m => ({ role: m.role, content: m.content }));
        const resp = await claudeChat({ messages: apiMessages, system, tools: AI_TOOLS, fileIds });

        const assistantMsg = { role: "assistant", content: resp.content };
        history = [...history, assistantMsg];
        setMessages(history);

        if (resp.stop_reason !== "tool_use") break;

        const toolUses = resp.content.filter(b => b.type === "tool_use");
        const toolResults = toolUses.map(tu => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: executeTool(tu.name, tu.input),
        }));
        const toolResultMsg = { role: "user", content: toolResults };
        history = [...history, toolResultMsg];
        setMessages(history);
      }
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", content: [{ type: "text", text: `(AI error: ${e.message})` }] }]);
    } finally {
      setPending(false);
    }
  };

  const onPickFiles = (e) => {
    const files = Array.from(e.target.files || []);
    setAttachments(a => [...a, ...files.map(f => ({ name: f.name, size: f.size }))]);
    e.target.value = "";
  };

  if (!open && !alwaysOpen) {
    return (
      <button className="ai-fab" onClick={onToggle}>
        <div className="ai-fab-pulse"></div>
        <span>AI Engine</span>
      </button>
    );
  }

  const showStarters = messages.length === 0 && !pending;

  return (
    <div className="ai">
      <div className="ai-head">
        <div className="ai-head-pulse"></div>
        <div className="ai-head-text">
          <div className="ai-head-title">AI Engine</div>
        </div>
        {messages.length > 0 && (
          <button className="ai-head-close" onClick={clearChat} title="Clear chat" style={{fontSize: 11, fontFamily: "var(--mono)", letterSpacing: "0.06em", padding: "4px 8px", textTransform: "uppercase"}}>Clear</button>
        )}
        {!alwaysOpen && <button className="ai-head-close" onClick={onToggle}>×</button>}
      </div>

      <div className="ai-msgs" ref={scrollRef}>
        {showStarters && (
          <div className="ai-empty">
            <div className="ai-empty-title">What's on your mind?</div>
            <div className="ai-empty-sub">Upload deal docs, log buyer feedback, or ask anything about the pipeline. The engine learns from every input.</div>
          </div>
        )}
        {messages.map((m, i) => {
          const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
          // Skip messages that are pure tool_results (internal); render the others.
          const isAllToolResults = blocks.every(b => b.type === "tool_result");
          if (isAllToolResults) {
            return blocks.map((b, j) => {
              const ok = typeof b.content === "string" && b.content.startsWith("ok:");
              return (
                <div key={`${i}-${j}`} className="ai-msg ai-msg-tool">
                  <div className="ai-msg-tag" style={{color: ok ? "var(--pos)" : "var(--neg)"}}>{ok ? "✓" : "!"}</div>
                  <div className="ai-msg-body" style={{color: "rgba(255,255,255,0.55)", fontFamily: "var(--mono)", fontSize: 11}}>
                    {typeof b.content === "string" ? b.content.replace(/^(ok|error):\s*/, "") : "applied"}
                  </div>
                </div>
              );
            });
          }
          return (
            <div key={i} className={"ai-msg ai-msg-" + m.role}>
              {m.role === "assistant" && <div className="ai-msg-tag">AI</div>}
              <div className="ai-msg-body">
                {blocks.map((b, j) => {
                  if (b.type === "text") return <div key={j}>{b.text}</div>;
                  if (b.type === "tool_use") {
                    return (
                      <div key={j} style={{fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginTop: 4}}>
                        → {b.name}({Object.entries(b.input).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ")})
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          );
        })}
        {pending && (
          <div className="ai-msg ai-msg-assistant">
            <div className="ai-msg-tag">AI</div>
            <div className="ai-msg-body ai-thinking"><span></span><span></span><span></span></div>
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div className="ai-pending-attachments">
          {attachments.map((a, i) => (
            <div key={i} className="ai-pending-chip">
              📎 {a.name}
              <button onClick={() => setAttachments(att => att.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}

      <form className="ai-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <button type="button" className="ai-input-attach" onClick={() => fileRef.current?.click()} title="Upload files">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
          </svg>
        </button>
        <input ref={fileRef} type="file" multiple style={{display: "none"}} onChange={onPickFiles} />
        <textarea
          rows={1}
          placeholder="Ask, upload, or log an update…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          disabled={pending}
        />
        <button type="submit" className="ai-input-send" disabled={pending || (!input.trim() && attachments.length === 0)} title="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="5" y1="12" x2="19" y2="12"/>
            <polyline points="12 5 19 12 12 19"/>
          </svg>
        </button>
      </form>
    </div>
  );
}

// ---------- AI history (audit trail) ----------
export function AIHistoryButton({ onClick, syncStatus }) {
  const dot = syncStatus === 'synced' ? 'var(--pos)'
    : syncStatus === 'syncing' ? 'var(--accent)'
    : syncStatus === 'offline' ? 'var(--neg, #c44)'
    : 'var(--ink-3)';
  const tip = syncStatus === 'synced' ? 'Synced to Postgres'
    : syncStatus === 'syncing' ? 'Saving to Postgres…'
    : syncStatus === 'offline' ? 'Server unavailable — using local only'
    : 'Loading';
  return (
    <button
      className="ai-history-btn"
      onClick={onClick}
      title={`AI audit log · ${tip}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8,
        background: 'transparent', border: '1px solid var(--rule-2)', borderRadius: 4,
        padding: '6px 12px', cursor: 'pointer',
        fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.06em',
        textTransform: 'uppercase', color: 'var(--ink-2)', transition: 'all 0.12s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ink)'; e.currentTarget.style.color = 'var(--bg)'; e.currentTarget.style.borderColor = 'var(--ink)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-2)'; e.currentTarget.style.borderColor = 'var(--rule-2)'; }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot }}></span>
      AI History
    </button>
  );
}

export function AIHistoryModal({ onClose, buyers }) {
  const [rescans, setRescans] = useState(null);
  const [error, setError] = useState(null);
  const buyerById = Object.fromEntries((buyers || []).map(b => [b.id, b]));

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/rescans?limit=50');
        if (!res.ok) {
          if (res.status === 503) {
            setError('Persistence unavailable — connect Postgres on Railway to enable audit history.');
          } else {
            setError(`Server returned ${res.status}`);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) setRescans(data.rescans || []);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 880 }}>
        <button className="modal-close" onClick={onClose}>×</button>
        <div className="modal-eyebrow">AI Audit Log</div>
        <div className="modal-title" style={{ fontSize: 30, marginBottom: 6 }}>Every rescan, recorded</div>
        <div className="modal-sub" style={{ marginBottom: 18 }}>
          Server-side log of every AI rescan call — inputs sent, outputs returned, web intel fetched, duration. Newest first.
        </div>

        {error && <div className="add-error" style={{ marginBottom: 12 }}>{error}</div>}
        {!error && rescans === null && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--ink-3)', fontSize: 13 }}>
            Loading audit log…
          </div>
        )}
        {rescans && rescans.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--ink-3)', fontSize: 13 }}>
            No rescans logged yet. Hit "Re-scan" in the top bar.
          </div>
        )}
        {rescans && rescans.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: '60vh', overflowY: 'auto' }}>
            {rescans.map(r => {
              const ts = new Date(r.ts);
              const isPipeline = r.scope === 'pipeline';
              const targetName = r.only_buyer_id ? (buyerById[r.only_buyer_id]?.name || r.only_buyer_id) : null;
              const out = r.output || {};
              return (
                <div key={r.id} style={{
                  border: '1px solid var(--rule)',
                  borderRadius: 4,
                  padding: '12px 14px',
                  background: 'var(--bg-card)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '0.04em', color: 'var(--ink-3)' }}>
                      {ts.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      {' · '}
                      <span style={{ color: 'var(--accent)', textTransform: 'uppercase' }}>
                        {isPipeline ? 'Pipeline rescan' : `Buyer · ${targetName}`}
                      </span>
                      {r.duration_ms && <> · {(r.duration_ms / 1000).toFixed(1)}s</>}
                      {r.live_intel && <> · web intel</>}
                      {r.error && <span style={{ color: 'var(--neg, #c44)' }}> · ERROR</span>}
                    </div>
                  </div>
                  {r.error && (
                    <div style={{ fontSize: 12, color: 'var(--neg, #c44)' }}>{r.error}</div>
                  )}
                  {out.summary && (
                    <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.5 }}>{out.summary}</div>
                  )}
                  {out.confidence_rationale && (
                    <div style={{ fontSize: 12, color: 'var(--ink-2)', fontStyle: 'italic', lineHeight: 1.5 }}>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--accent)', marginRight: 6 }}>Confidence</span>
                      {out.confidence_rationale}
                    </div>
                  )}
                  {Array.isArray(out.buyers) && out.buyers.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink-3)' }}>
                        {out.buyers.length} buyer update{out.buyers.length === 1 ? '' : 's'}
                      </summary>
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, borderLeft: '2px solid var(--rule)' }}>
                        {out.buyers.map(b => (
                          <div key={b.id} style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                            <b style={{ color: 'var(--ink)' }}>{buyerById[b.id]?.name || b.id}</b>
                            {' — p='}{b.probability}{'%'}
                            {b.reasoning && <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--ink-3)' }}>{b.reasoning}</div>}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  {r.live_intel && (
                    <details>
                      <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.06em', color: 'var(--ink-3)' }}>
                        Web intel ({r.live_intel.length.toLocaleString()} chars)
                      </summary>
                      <pre style={{ marginTop: 8, padding: 10, fontSize: 11, lineHeight: 1.5, background: 'var(--bg)', border: '1px solid var(--rule)', borderRadius: 2, whiteSpace: 'pre-wrap', maxHeight: 240, overflowY: 'auto' }}>
                        {r.live_intel}
                      </pre>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
