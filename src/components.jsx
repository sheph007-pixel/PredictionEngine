import { useState, useEffect, useRef } from 'react';
import { STAGES, STAGE_INDEX, PROCESS_TASKS, PHASES, PHASE_DESCRIPTIONS } from './data.js';
import { claudeChat } from './utils/ai.js';
import { PUBLIC_COMP_BY_TICKER, PUBLIC_COMP_BANDS } from './data/precedents.js';
import { relativeTime, EVENT_SPECS, NOTE_SIGNALS } from './lib/notes.js';

const SIGNAL_COLORS = {
  warming: '#2f8c4d',
  cooling: '#a83232',
  firm: '#0a4d8c',
  stalling: '#8c6f1a',
  passed: '#666666',
};
const SIGNAL_HINTS = {
  warming: 'Buyer trajectory is heating up (engagement, follow-ups, sponsor signals)',
  cooling: 'Buyer is going quiet, pulling back, or signaling lower priority',
  firm: 'Hard evidence of price/terms (LOI, term sheet, written or explicit verbal offer)',
  stalling: 'Process is stuck, meetings keep getting moved, decisions deferred',
  passed: 'Buyer formally passed on the process',
};

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

// Derive the current process phase from live buyer state. Replaces the
// manually-managed `currentTaskId`. Phase = the most-advanced live buyer's
// stage mapped to a phase bucket. Distribution = a one-line breakdown of
// where each live buyer sits within the active phase (NDA+CIM vs NDA pending,
// chemistry+IOI vs chemistry, etc.). Used by ProcessTracker (display) and
// HeroKPIs (timeline math) so the deal-level view stays honest as buyers move.
export function derivePhase(buyers) {
  const live = (buyers || []).filter(b => b.stage !== 'dropped');
  const droppedCount = (buyers || []).filter(b => b.stage === 'dropped').length;

  let phase = 'Marketing Phase 1', phaseIdx = 1, weeksToClose = 17, weeksToOffer = 7;
  if (live.length === 0) {
    return { phase: 'Building Materials', phaseIdx: 0, weeksToClose: 22, weeksToOffer: 12, distribution: {}, distributionText: 'no live buyers', droppedCount };
  }
  const maxStageIdx = Math.max(...live.map(b => STAGE_INDEX[b.stage] ?? 0));
  // Per the Reagan timeline, LOIs are RECEIVED in Marketing Phase 2 and
  // Exclusivity starts only after the seller selects a winner. We don't have
  // an explicit "selected" stage, so model selection as "exactly one live
  // buyer at LOI or beyond" — the natural correlate, since the losers get
  // dropped/cooled when a winner is picked.
  const liveAtLoiOrBeyond = live.filter(b => (STAGE_INDEX[b.stage] ?? 0) >= STAGE_INDEX.loi).length;
  if (maxStageIdx >= STAGE_INDEX.closed) { phase = 'Close'; phaseIdx = 4; weeksToClose = 0; weeksToOffer = 0; }
  else if (liveAtLoiOrBeyond === 1) { phase = 'Exclusivity'; phaseIdx = 3; weeksToClose = 7; weeksToOffer = 0; }
  else if (maxStageIdx >= STAGE_INDEX.chemistry || maxStageIdx >= STAGE_INDEX.loi) { phase = 'Marketing Phase 2'; phaseIdx = 2; weeksToClose = 13; weeksToOffer = 3; }

  const c = {
    outreach:  live.filter(b => b.stage === 'outreach').length,
    ndaCim:    live.filter(b => b.stage === 'nda' && b.cim_delivered).length,
    ndaOnly:   live.filter(b => b.stage === 'nda' && !b.cim_delivered).length,
    chemIoi:   live.filter(b => b.stage === 'chemistry' && b.ioi_received).length,
    chemOnly:  live.filter(b => b.stage === 'chemistry' && !b.ioi_received).length,
    loi:       live.filter(b => b.stage === 'loi').length,
    closed:    live.filter(b => b.stage === 'closed').length,
  };
  const parts = [];
  if (c.closed)    parts.push(`${c.closed} closed`);
  if (c.loi)       parts.push(`${c.loi} LOI`);
  if (c.chemIoi)   parts.push(`${c.chemIoi} chemistry+IOI`);
  if (c.chemOnly)  parts.push(`${c.chemOnly} chemistry`);
  if (c.ndaCim)    parts.push(`${c.ndaCim} NDA+CIM`);
  if (c.ndaOnly)   parts.push(`${c.ndaOnly} NDA pending`);
  if (c.outreach)  parts.push(`${c.outreach} outreach`);
  const distributionText = parts.join(' · ') || `${live.length} live`;

  return { phase, phaseIdx, weeksToClose, weeksToOffer, distribution: c, distributionText, droppedCount };
}

function projectTaskDates(process) {
  const anchor = PROCESS_TASKS.find(t => t.id === process.currentTaskId);
  const anchorWeeks = anchor.weeksFromStart;
  return PROCESS_TASKS.map(t => ({
    ...t,
    projectedDate: addWeeks(process.currentTaskDate, t.weeksFromStart - anchorWeeks),
  }));
}

// The AI's stage-aware probability is the ground truth. The system prompt
// (see server.js) enforces stage discipline ranges (outreach 8–22%, nda
// 12–28%, chemistry 18–38%, loi 28–58%, closed 90+%), so we display what
// the AI returned without post-processing, no hand-rolled stage lift.
export function probabilityFor(buyer) {
  const p = buyer.probability;
  if (typeof p !== 'number' || !Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(95, Math.round(p)));
}

// Winner allocation: deal-closes probability is the union over independent
// buyers (1 − ∏(1 − pᵢ)). The slice each buyer wins is proportional to
// their AI probability, no extra stage re-weighting (the AI already bakes
// stage into the number).
// `aiNoDeal` is the AI-reported p_no_deal (0-100) when available. Passing it
// lets the row's no-deal value AND the KPI's deal-confidence value agree
// (both derive from the same source). Without it, the row falls back to a
// computed independent-union estimate which can drift 2-3 points from the
// AI's number — small but visible inconsistency the user notices.
export function winnerProbabilities(buyers, _ebitda, _caseMode, aiNoDeal) {
  const live = buyers.filter(b => b.stage !== "dropped");
  if (live.length === 0) return { winnerByBuyer: {}, noDealPct: 100, dealClosesPct: 0 };

  // Anchor on AI's p_no_deal when present so the row + KPI agree. Otherwise
  // fall back to the computed union-of-independent-events estimate.
  let dealClosesPct;
  if (typeof aiNoDeal === 'number' && Number.isFinite(aiNoDeal)) {
    dealClosesPct = Math.max(0, Math.min(100, 100 - Math.round(aiNoDeal)));
  } else {
    const dealClosesProb = 1 - live.reduce((acc, b) => acc * (1 - probabilityFor(b) / 100), 1);
    dealClosesPct = Math.round(dealClosesProb * 100);
  }
  const noDealPct = 100 - dealClosesPct;

  const totalProb = live.reduce((s, b) => s + probabilityFor(b), 0) || 1;

  const winnerByBuyer = {};
  let assigned = 0;
  live.forEach((b, i) => {
    if (i === live.length - 1) {
      winnerByBuyer[b.id] = Math.max(0, dealClosesPct - assigned);
    } else {
      const pct = Math.round((probabilityFor(b) / totalProb) * dealClosesPct);
      winnerByBuyer[b.id] = pct;
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
export function valuationFor(buyer, ebitda = 0, caseMode = "mid", market) {
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
    const seed = marketMultiplesSeed(ebitda).mid;
    baseLow = seed.low;
    baseHigh = seed.high;
    baseMid = (seed.low + seed.high) / 2;
  }

  // Stage tightening, only applies when no override (override is already firm).
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

function quickThesis(thesis, maxChars = 140) {
  if (!thesis) return "";
  const firstSentence = thesis.split(/(?<=[.!?])\s+/)[0] || thesis;
  if (firstSentence.length <= maxChars) return firstSentence;
  return firstSentence.slice(0, maxChars).replace(/\s+\S*$/, "") + "…";
}

export function fmtMoney(m) {
  if (m >= 1000) return "$" + (m / 1000).toFixed(2) + "B";
  return "$" + Math.round(m) + "M";
}

// Pre-rescan fallback: deterministic bullets derived from seed fit scores +
// flags. Only used when no AI rescan has run yet (buyer.lastAnalyzed == null).
// Once the engine has scored the buyer, the AI's `aiNotes` is shown instead.
function heuristicReasonsFor(buyer) {
  const reasons = [];
  if (buyer.fit.benefits >= 4) reasons.push({ kind: "+", text: "High benefits-vertical alignment" });
  if (buyer.fit.size >= 4) reasons.push({ kind: "+", text: "Capital base supports bid at market clear" });
  if (buyer.fit.precedent >= 4) reasons.push({ kind: "+", text: "Active 2025-26 M&A precedent" });
  if (buyer.fit.benefits <= 2) reasons.push({ kind: "−", text: "Limited benefits focus" });
  if (buyer.fit.size <= 2) reasons.push({ kind: "−", text: "Capacity constraint at our scale" });
  if (buyer.stage === "chemistry") reasons.push({ kind: "+", text: "Chemistry meeting on calendar" });
  if (buyer.stage === "loi") reasons.push({ kind: "+", text: "LOI received" });
  return reasons.slice(0, 4);
}

// Stage discipline ranges enforced by the rescan system prompt. Used in the
// Research card to show the user where the AI's raw probability sits within
// its allowed range for the current stage.
export const STAGE_PROB_RANGE = {
  outreach:  { low: 8,  high: 22 },
  nda:       { low: 12, high: 28 },
  chemistry: { low: 18, high: 38 },
  loi:       { low: 28, high: 58 },
  closed:    { low: 90, high: 100 },
};

// ---------- hero KPIs ----------
// Two-model voting strip, shows Claude's and GPT's individual predictions
// side by side with an "avg" pill, letting the user see both reads at once
// instead of just the blended number.
function ModelVote({ claudeVal, openaiVal, avgVal, claudeReasoning, openaiReasoning, avgTitle: avgTitleOverride, avgLabel = 'avg' }) {
  const has = claudeVal != null || openaiVal != null;
  if (!has) return null;
  const claudeTitle = claudeReasoning
    ? `Claude said ${claudeVal}: ${claudeReasoning}`
    : `Claude (Anthropic) prediction: ${claudeVal ?? '-'}`;
  const openaiTitle = openaiReasoning
    ? `GPT-4o said ${openaiVal}: ${openaiReasoning}`
    : `GPT-4o (OpenAI) prediction: ${openaiVal ?? '-'}`;
  // Caller may override avgTitle when avgVal isn't a simple (C+G)/2 average —
  // e.g., the buyer row passes a winner-share value here, which is computed
  // from blended raw probabilities normalized so all rows + no-deal = 100.
  // Also overrides the chip label so "avg" doesn't mislead (the buyer row
  // uses "share").
  const avgTitle = avgTitleOverride
    || `Averaged: Claude ${claudeVal ?? '-'} + GPT ${openaiVal ?? '-'} → ${avgVal}. Drives the headline number.`;
  return (
    <div className="model-vote">
      <span className="model-chip model-chip-claude" title={claudeTitle}>
        <span className="model-chip-mark">C</span>
        <span className="model-chip-val">{claudeVal ?? '-'}</span>
      </span>
      <span className="model-chip model-chip-openai" title={openaiTitle}>
        <span className="model-chip-mark">G</span>
        <span className="model-chip-val">{openaiVal ?? '-'}</span>
      </span>
      <span className="model-chip model-chip-avg" title={avgTitle}>
        <span className="model-chip-mark">{avgLabel}</span>
        <span className="model-chip-val">{avgVal}</span>
      </span>
    </div>
  );
}

// Render YYYY-MM as "Sep 2026"; falls back to raw string if malformed.
function fmtCloseMonth(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return s;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// Returns the current Date and ticks every `intervalMs`. Used by the hero
// KPIs to drive a live countdown to projected offer / close. 60s cadence is
// intentional: at a multi-week horizon, ticking seconds is visual noise and
// re-renders the hero unnecessarily; minutes still feel alive on the page.
function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Formats a future Date as "Xd Yh Zm" from `now`. Returns "overdue" if the
// target is already past. Consumed by the hero foot-line countdown text.
function fmtCountdown(target, now) {
  if (!target) return null;
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return 'overdue';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${d}d ${h}h ${m}m`;
}

export function HeroKPIs({ buyers, process, ebitda, caseMode, market, rationales }) {
  const derived = derivePhase(buyers);
  const today = useNow(60_000);
  const weeksToClose = derived.weeksToClose;
  const weeksToOffer = derived.weeksToOffer;
  const projectedClose = new Date(today);
  projectedClose.setDate(projectedClose.getDate() + weeksToClose * 7);
  const projectedOffer = new Date(today);
  projectedOffer.setDate(projectedOffer.getDate() + weeksToOffer * 7);

  const aiNoDeal = typeof rationales?.p_no_deal === 'number' ? rationales.p_no_deal : null;
  const computed = winnerProbabilities(buyers, ebitda, caseMode, aiNoDeal);
  const dealClosesPct = aiNoDeal != null ? Math.max(0, 100 - aiNoDeal) : computed.dealClosesPct;
  const confLevel = dealClosesPct >= 85 ? "High" : dealClosesPct >= 65 ? "Solid" : dealClosesPct >= 40 ? "Moderate" : "Low";

  const models = rationales?.models;

  // AI-predicted close month overrides the process-derived date when present.
  const aiCloseMonth = rationales?.close_estimate ? fmtCloseMonth(rationales.close_estimate) : null;
  const headlineClose = aiCloseMonth || fmtMonthYear(projectedClose);

  // Keep "weeks remaining" honest to the headline date. When the AI overrides
  // the close month, recompute weeks from today to mid-month of that estimate.
  const parseYearMonth = (s) => {
    if (typeof s !== 'string') return null;
    const m = s.match(/^(\d{4})-(\d{1,2})$/);
    if (!m) return null;
    return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 15);
  };
  const aiCloseDate = parseYearMonth(rationales?.close_estimate);
  const weeksRemaining = aiCloseDate
    ? Math.max(0, Math.round((aiCloseDate - today) / (7 * 86400000)))
    : weeksToClose;

  // AI-predicted first-offer month overrides the process-derived offer date.
  const aiOfferMonth = rationales?.offer_estimate ? fmtCloseMonth(rationales.offer_estimate) : null;
  const headlineOffer = aiOfferMonth || fmtMonthYear(projectedOffer);
  const aiOfferDate = parseYearMonth(rationales?.offer_estimate);
  const weeksToOfferDisplay = aiOfferDate
    ? Math.max(0, Math.round((aiOfferDate - today) / (7 * 86400000)))
    : weeksToOffer;
  const offerChips = models?.claude?.offer_estimate || models?.openai?.offer_estimate ? {
    claude: models?.claude?.offer_estimate ? fmtCloseMonth(models.claude.offer_estimate) : null,
    openai: models?.openai?.offer_estimate ? fmtCloseMonth(models.openai.offer_estimate) : null,
    avg: aiOfferMonth || fmtMonthYear(projectedOffer),
  } : null;

  // Per-card chip values, Claude vs GPT vs avg.
  const closeChips = models?.claude?.close_estimate || models?.openai?.close_estimate ? {
    claude: models?.claude?.close_estimate ? fmtCloseMonth(models.claude.close_estimate) : null,
    openai: models?.openai?.close_estimate ? fmtCloseMonth(models.openai.close_estimate) : null,
    avg: aiCloseMonth || fmtMonthYear(projectedClose),
  } : null;

  const confChips = (models?.claude && typeof models.claude.p_no_deal === 'number') || (models?.openai && typeof models.openai.p_no_deal === 'number') ? {
    claude: typeof models?.claude?.p_no_deal === 'number' ? `${100 - models.claude.p_no_deal}%` : null,
    openai: typeof models?.openai?.p_no_deal === 'number' ? `${100 - models.openai.p_no_deal}%` : null,
    avg: `${dealClosesPct}%`,
  } : null;

  const m = (market && market[caseMode]) || marketMultiplesSeed(ebitda)[caseMode] || marketMultiplesSeed(ebitda).mid;

  const fmtBand = (band) => band ? `${band.low?.toFixed(1)}–${band.high?.toFixed(1)}×` : null;
  const priceChips = models?.claude?.market || models?.openai?.market ? {
    claude: fmtBand(models?.claude?.market?.[caseMode]),
    openai: fmtBand(models?.openai?.market?.[caseMode]),
    avg: `${m.low.toFixed(1)}–${m.high.toFixed(1)}×`,
  } : null;
  const clearLow = ebitda * m.low;
  const clearHigh = ebitda * m.high;
  const clearMid = ebitda * ((m.low + m.high) / 2);

  return (
    <div className="hero">
      <div className="hero-kpi">
        <div className="hero-kpi-label">Projected offer</div>
        <div className="hero-kpi-value hero-kpi-close">{headlineOffer}</div>
        <div className="hero-kpi-foot" title={`${fmtCountdown(aiOfferDate || projectedOffer, today)} to first offer · ${derived.phase}`}><b>{fmtCountdown(aiOfferDate || projectedOffer, today)}</b> to first offer · <b>{derived.phase}</b></div>
        {offerChips && <ModelVote claudeVal={offerChips.claude} openaiVal={offerChips.openai} avgVal={offerChips.avg} />}
      </div>
      <div className="hero-kpi">
        <div className="hero-kpi-label">Projected close</div>
        <div className="hero-kpi-value hero-kpi-close">{headlineClose}</div>
        <div className="hero-kpi-foot" title={`${fmtCountdown(aiCloseDate || projectedClose, today)} remaining · ${derived.phase}`}><b>{fmtCountdown(aiCloseDate || projectedClose, today)}</b> remaining · <b>{derived.phase}</b></div>
        {closeChips && <ModelVote claudeVal={closeChips.claude} openaiVal={closeChips.openai} avgVal={closeChips.avg} />}
      </div>
      <div className="hero-kpi">
        <div className="hero-kpi-label">Deal confidence{aiNoDeal != null && <span className="hero-kpi-case"> · AI no-deal {aiNoDeal}%</span>}</div>
        <div className="hero-kpi-value hero-kpi-confidence">{dealClosesPct}%</div>
        <div className="hero-kpi-foot"><b>{confLevel}</b> probability any deal closes{aiNoDeal == null && <> · <i style={{opacity:.6}}>computed (no AI rescan yet)</i></>}</div>
        {confChips && <ModelVote claudeVal={confChips.claude} openaiVal={confChips.openai} avgVal={confChips.avg} />}
      </div>
      <div className="hero-kpi">
        <div className="hero-kpi-label">Market clearing price <span className="hero-kpi-case">· {m.label}</span></div>
        <div className="hero-kpi-value hero-kpi-pipeline">{fmtMoney(clearMid)}</div>
        <div className="hero-kpi-foot">{fmtMoney(clearLow)}–{fmtMoney(clearHigh)} · ${ebitda}M EBITDA × <b>{m.low.toFixed(1)}–{m.high.toFixed(1)}×</b></div>
        {priceChips && <ModelVote claudeVal={priceChips.claude} openaiVal={priceChips.openai} avgVal={priceChips.avg} />}
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
  const derived = derivePhase(buyers);
  // Manual override wins if the user clicked a phase explicitly; otherwise the
  // phase auto-derives from buyer state. Lets you say "we're in Q&A even though
  // no buyer has formally moved" without the auto-derivation overriding you.
  const activePhase = process?.phase || derived.phase;
  const activeIdx = Math.max(0, PHASES.indexOf(activePhase));
  const pctDone = Math.round((activeIdx / (PHASES.length - 1)) * 100);
  const isAuto = !process?.phase;

  return (
    <div className={"process process-thin" + (collapsed ? " process-collapsed" : "")}>
      <div className="process-thin-head" onClick={() => setCollapsed(!collapsed)}>
        <div className="process-thin-left">
          <div className="process-eyebrow">Process · Reagan Consulting</div>
          <div className="process-thin-title">
            <span className="process-thin-phase">Phase {activeIdx + 1}/{PHASES.length} · {activePhase}</span>
            <span className="process-thin-task">{derived.distributionText}{derived.droppedCount > 0 && ` · ${derived.droppedCount} dropped`}{isAuto && ' · auto'}</span>
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
        <div className="process-rail process-rail-phases">
          {PHASES.map((phase, i) => {
            const state = i < activeIdx ? "done" : i === activeIdx ? "active" : "future";
            const onClick = (e) => {
              e.stopPropagation();
              if (i === activeIdx && process?.phase) {
                // Click the active phase again → release manual override, fall back to auto
                const { phase: _, ...rest } = process || {};
                onUpdate(rest);
              } else {
                onUpdate({ ...(process || {}), phase });
              }
            };
            return (
              <button
                key={phase}
                type="button"
                className={"process-phase-pip process-phase-pip-" + state}
                onClick={onClick}
                title={i === activeIdx && process?.phase ? `Click to release manual override (auto would be: ${derived.phase})` : `Mark ${phase} as current phase`}
              >
                <div className="process-phase-pip-dot"></div>
                <div className="process-phase-pip-label">{phase}</div>
                <div className="process-phase-pip-sub">{PHASE_DESCRIPTIONS[phase]}</div>
                {i === activeIdx && (
                  <div className="process-phase-pip-detail">{derived.distributionText}</div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Pre-rescan defaults. Insurance/benefits brokerage multiples scale strongly
// with EBITDA, a sub-$5M book does not clear at mid-market multiples. Keep
// the seed conservative; the AI rescan tightens the band with real evidence.
export function marketMultiplesSeed(ebitda) {
  const e = Number(ebitda) || 0;
  const bucket =
    e < 3  ? { c: [3.0, 4.5], m: [4.0, 6.0], a: [5.5, 7.5], tag: "<$3M sub-scale" } :
    e < 5  ? { c: [4.0, 5.5], m: [5.0, 7.0], a: [6.5, 8.5], tag: "$3–5M captive-niche" } :
    e < 10 ? { c: [5.0, 7.0], m: [6.5, 8.5], a: [8.0, 10.5], tag: "$5–10M lower mid-mkt" } :
    e < 20 ? { c: [6.5, 8.5], m: [8.0, 10.5], a: [10.0, 13.0], tag: "$10–20M mid-mkt" } :
    e < 50 ? { c: [8.5, 10.5], m: [10.0, 12.5], a: [12.0, 14.5], tag: "$20–50M mid-mkt PE" } :
             { c: [9.5, 11.5], m: [11.0, 13.5], a: [13.0, 16.0], tag: ">$50M scaled" };
  return {
    conservative: { low: bucket.c[0], high: bucket.c[1], label: "Conservative", note: `Bear · ${bucket.tag} · soft market` },
    mid:          { low: bucket.m[0], high: bucket.m[1], label: "Realistic",   note: `Base · ${bucket.tag} · pre-rescan default` },
    aggressive:   { low: bucket.a[0], high: bucket.a[1], label: "Aggressive",  note: `Bull · ${bucket.tag} · strategic premium` },
  };
}

// ---------- system bar ----------
export function SystemBar({ ebitda, onEbitda, caseMode, onCase, market, marketMeta, onRescan, rescanError, clearingRationale, lastRescanTs, lastAttemptTs }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(ebitda));
  const [refreshing, setRefreshing] = useState(false);
  const [localErr, setLocalErr] = useState(null);
  // Elapsed ms since rescan started, drives the in-button progress bar +
  // "Updating… 4s" counter so the user knows it's not stuck.
  const [elapsed, setElapsed] = useState(0);
  // Tick once per second when idle so the "updated 30s ago" label stays
  // current without an explicit re-render trigger.
  const [, setTick] = useState(0);
  const lastClickRef = useRef(0);
  const startedAtRef = useRef(0);
  useEffect(() => setDraft(String(ebitda)), [ebitda]);

  // Most rescans land in 3–8s now that live web intel is off; the bar reaches
  // ~95% at 9s and holds there until the response arrives, then snaps to 100.
  const EXPECTED_MS = 9000;

  useEffect(() => {
    if (!refreshing) return;
    const id = setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
    }, 200);
    return () => clearInterval(id);
  }, [refreshing]);

  useEffect(() => {
    if (refreshing || !lastRescanTs) return;
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, [refreshing, lastRescanTs]);

  const mult = market || marketMultiplesSeed(ebitda);
  const cases = ["conservative", "mid", "aggressive"];

  const commit = () => {
    const n = parseFloat(draft);
    if (!isNaN(n) && n > 0) onEbitda(n);
    else setDraft(String(ebitda));
    setEditing(false);
  };

  const rescan = async () => {
    // Hard 1.5s lockout in addition to the in-flight guard, so a
    // double-click can't fire two API calls back-to-back.
    const now = Date.now();
    if (refreshing || !onRescan || now - lastClickRef.current < 1500) return;
    lastClickRef.current = now;
    startedAtRef.current = now;
    setElapsed(0);
    setRefreshing(true);
    setLocalErr(null);
    try {
      await onRescan();
    } catch (e) {
      setLocalErr(e.message || 'Re-scan failed');
    } finally {
      setRefreshing(false);
      setElapsed(0);
    }
  };

  const errorMsg = localErr || rescanError;
  const elapsedSec = Math.floor(elapsed / 1000);
  // Cap at 95% so the bar never claims completion, when the response lands,
  // setRefreshing(false) clears the bar entirely (visually a snap to done).
  const progressPct = refreshing ? Math.min(95, Math.round((elapsed / EXPECTED_MS) * 100)) : 0;
  const lastUpdatedRel = lastRescanTs ? relativeTime(lastRescanTs) : null;
  // The last refresh attempt may have failed silently (network blip, AI 500,
  // schema mismatch). Compare the last attempt to the last success: if the
  // attempt is materially newer, the data displayed is older than the user
  // expects, surface a 'last try failed' suffix so the label can't lie.
  const successMs = lastRescanTs ? new Date(lastRescanTs).getTime() : 0;
  const attemptMs = lastAttemptTs ? new Date(lastAttemptTs).getTime() : 0;
  const lastTryFailed = attemptMs > 0 && attemptMs > successMs + 30_000;
  const lastTryRel = lastTryFailed ? relativeTime(lastAttemptTs) : null;

  return (
    <div className="sysbar">
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
        className={"sysbar-update" + (refreshing ? " refreshing" : "") + (errorMsg ? " err" : "")}
        onClick={rescan}
        disabled={refreshing}
        title={errorMsg ? `Update failed: ${errorMsg}` : (marketMeta || "Re-score every buyer + market bands using AI on full evidence (notes, docs, prior reasoning)")}
      >
        {refreshing && (
          <span className="sysbar-update-progress" style={{ width: progressPct + '%' }} aria-hidden="true"></span>
        )}
        <span className="sysbar-update-content">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10"/>
            <polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          {refreshing
            ? <>Updating… <span className="sysbar-update-elapsed">{elapsedSec}s</span></>
            : errorMsg ? "Retry" : "Update"}
        </span>
      </button>
      {lastUpdatedRel && !refreshing && !errorMsg && (
        <div
          className={"sysbar-last" + (lastTryFailed ? " sysbar-last-failed" : "")}
          title={lastTryFailed
            ? `Last successful AI rescan: ${new Date(lastRescanTs).toLocaleString()}\nLast attempt (failed): ${new Date(lastAttemptTs).toLocaleString()}`
            : `Last AI rescan: ${new Date(lastRescanTs).toLocaleString()}`}
        >
          {lastTryFailed
            ? <>last try failed {lastTryRel} · prior success {lastUpdatedRel}</>
            : <>updated {lastUpdatedRel}</>}
        </div>
      )}
      <div className="sysbar-live" title={marketMeta || "Last AI re-scan"}>
        <span className={"live-dot" + (errorMsg ? " live-dot-err" : "")}></span>
      </div>
      {errorMsg && (
        <div className="sysbar-err" role="alert" title={errorMsg}>
          AI scan failed: {errorMsg}
        </div>
      )}
    </div>
  );
}

export function ValuationBar({ ebitda, onEbitda, caseMode, onCase, market, marketMeta, onRefreshMarket }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(ebitda));
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => setDraft(String(ebitda)), [ebitda]);

  const mult = market || marketMultiplesSeed(ebitda);
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
        <div className="stat-value stat-value-sm">{top ? top.name : "-"}</div>
        <div className="stat-sub2">{top ? probabilityFor(top) : 0}% probability</div>
        <div className="stat-sub2-muted">{topV ? fmtMoney(topV.headlineDollar) : "-"} expected value</div>
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

// ---------- buyer row ----------
// Buyer row: rank · name · 8th-grade thesis blurb · stage · win% (with movement) · [+]
//   - Click anywhere (except [+]) → opens modal for full context
//   - Click [+] → expands inline input panel: signal chips + textarea + Submit
//   - Submit appends a tagged note + triggers a per-buyer rescan, which
//     re-ranks the entire list (App.jsx re-sorts on every render).
//   - Up/down arrow shows last AI re-score's probability change (from aiHistory).
export function BuyerRow({ buyer, selected, onSelect, onAppendNote, onRescanBuyer, rescanning, displayRank, winShare }) {
  const isDropped = buyer.stage === "dropped";
  // Winner-allocated share of the deal-closes probability. Per-buyer
  // shares + no-deal sum to 100, so the user's mental math adds up.
  // `winShare` is passed in by App.jsx via winnerProbabilities. The raw
  // AI probability stays accessible via the chip tooltips for debugging
  // and per-model divergence visibility, but the headline number is the
  // share.
  const showProb = isDropped ? 0 : (typeof winShare === 'number' ? winShare : probabilityFor(buyer));
  const stageLabel = STAGES.find(s => s.id === buyer.stage)?.label || buyer.stage;

  const updatedAt = buyer.lastAnalyzed ? relativeTime(buyer.lastAnalyzed) : null;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [signal, setSignal] = useState(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e?.stopPropagation();
    const text = draft.trim();
    if (!text || pending) return;
    setPending(true);
    setErr(null);
    const newNoteId = onAppendNote ? onAppendNote(buyer.id, text, signal) : null;
    try {
      if (onRescanBuyer) await onRescanBuyer(buyer.id, { triggerNoteId: newNoteId });
      setDraft('');
      setSignal(null);
      setOpen(false);
    } catch (ex) {
      setErr(ex.message || 're-scan failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className={"row" + (selected ? " row-selected" : "") + (isDropped ? " row-passed" : "") + (rescanning ? " row-rescanning" : "")}
      onClick={onSelect}
    >
      <div className="row-rank">{isDropped ? '-' : displayRank}</div>
      <div className="row-name-block">
        <div className="row-name-main">
          {buyer.website ? (
            <>
              <a
                className="row-name-link"
                href={buyer.website}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
              >{buyer.name}</a>
              <a
                className="row-name-ext"
                href={buyer.website}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={`Open ${buyer.website}`}
                aria-label={`Open ${buyer.name} website in a new tab`}
              >↗</a>
            </>
          ) : buyer.name}
          {typeof buyer.top100_rank === 'number' && (
            <span className="top100-badge" title={`Business Insurance · 100 Largest Brokers of U.S. Business (July/August 2025) · rank #${buyer.top100_rank}`}>#{buyer.top100_rank}</span>
          )}
          {buyer.top100_rank === null && (
            <span className="top100-badge top100-badge-nr" title="Not in Business Insurance's 100 Largest Brokers of U.S. Business (July/August 2025)">NR</span>
          )}
          {buyer.pe_backed && (
            <span className="pe-badge" title={`PE-backed${buyer.sponsor ? ` · ${buyer.sponsor}` : ''}`}>PE</span>
          )}
          {rescanning && <span className="row-rescanning-tag" style={{ marginLeft: 10 }}>AI re-scoring…</span>}
        </div>
        {!isDropped && (
          buyer.thesis
            ? <div className="row-name-thesis">{buyer.thesis}</div>
            : <div className="row-name-thesis row-name-thesis-empty">Re-scan to generate the AI's reason for this ranking.</div>
        )}
      </div>
      {isDropped ? (
        <div className="row-stage row-stage-dropped">dropped</div>
      ) : (
        <div className="row-stage" title={`Stage: ${stageLabel}`}>
          <div className="row-stage-pips">
            {STAGES.filter(s => s.id !== 'dropped').map((s, i) => {
              const idx = STAGE_INDEX[buyer.stage];
              const cls =
                i < idx ? 'row-stage-pip row-stage-pip-done' :
                i === idx ? 'row-stage-pip row-stage-pip-active' :
                'row-stage-pip';
              return <span key={s.id} className={cls} title={s.label} />;
            })}
          </div>
          <div className="row-stage-label">
            {stageLabel}
            {buyer.stage === 'nda' && buyer.cim_delivered && (
              <span className="row-stage-substage" title={`CIM delivered ${buyer.cim_delivered}`}> · CIM SENT</span>
            )}
            {buyer.stage === 'chemistry' && buyer.ioi_received && (
              <span className="row-stage-substage" title={`IOI received ${buyer.ioi_received}`}> · IOI</span>
            )}
          </div>
        </div>
      )}
      <div className="row-prob-stack">
        <div className="row-prob-num">
          {isDropped ? '-' : showProb}<span>{isDropped ? '' : '%'}</span>
        </div>
        {!isDropped && buyer.modelVote && (typeof buyer.modelVote.claude === 'number' || typeof buyer.modelVote.openai === 'number') && (() => {
          // Scale each model's raw per-buyer probability by the same factor
          // that maps the blended raw to the row's winner share. With all
          // three numbers in the same "share of deal-closing probability"
          // space, the user's natural arithmetic — avg(C, G) ≈ share —
          // actually holds. Tooltips preserve the raw model votes.
          const rawC = buyer.modelVote.claude;
          const rawG = buyer.modelVote.openai;
          const blendedRaw = typeof buyer.probability === 'number' ? buyer.probability : null;
          const scale = (typeof blendedRaw === 'number' && blendedRaw > 0 && showProb > 0)
            ? showProb / blendedRaw
            : 1;
          const cShare = typeof rawC === 'number' ? Math.round(rawC * scale) : null;
          const gShare = typeof rawG === 'number' ? Math.round(rawG * scale) : null;
          return (
            <ModelVote
              claudeVal={cShare != null ? `${cShare}%` : null}
              openaiVal={gShare != null ? `${gShare}%` : null}
              avgVal={`${showProb}%`}
              avgLabel="share"
              avgTitle={`${showProb}% is this buyer's share of the deal-closing probability. All buyer shares + no-deal sum to 100%. Each chip shows the same share lens: Claude raw ${rawC ?? '-'}% → ${cShare ?? '-'}% share, GPT raw ${rawG ?? '-'}% → ${gShare ?? '-'}% share, blended share ${showProb}%.`}
              claudeReasoning={buyer.modelVote.claudeReasoning ? `Raw ${rawC}% → ${cShare}% share. ${buyer.modelVote.claudeReasoning}` : `Claude raw ${rawC}% → ${cShare}% share (winner-allocated).`}
              openaiReasoning={buyer.modelVote.openaiReasoning ? `Raw ${rawG}% → ${gShare}% share. ${buyer.modelVote.openaiReasoning}` : `GPT raw ${rawG}% → ${gShare}% share (winner-allocated).`}
            />
          );
        })()}
        {updatedAt && !isDropped && (
          <div className="row-prob-foot" title={`Last AI re-score: ${new Date(buyer.lastAnalyzed).toLocaleString()}`}>updated {updatedAt}</div>
        )}
      </div>
      <button
        type="button"
        className={"row-add-btn" + (open ? " row-add-btn-open" : "")}
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        title={open ? 'Close input' : 'Add field intel · re-rank'}
        aria-label={open ? 'Close input' : 'Add input'}
        disabled={isDropped}
      >{open ? '×' : '+'}</button>

      {open && (
        <div className="row-input" onClick={(e) => e.stopPropagation()}>
          <div className="row-input-signals">
            <span className="row-input-sig-label">Signal:</span>
            {NOTE_SIGNALS.map(sig => (
              <button
                key={sig}
                type="button"
                className="chip"
                onClick={() => setSignal(s => s === sig ? null : sig)}
                disabled={pending}
                style={{
                  borderColor: signal === sig ? SIGNAL_COLORS[sig] : undefined,
                  background: signal === sig ? SIGNAL_COLORS[sig] + '22' : undefined,
                  color: signal === sig ? SIGNAL_COLORS[sig] : undefined,
                  fontSize: 11,
                }}
                title={SIGNAL_HINTS[sig]}
              >{sig}</button>
            ))}
          </div>
          <textarea
            className="row-input-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What's the latest? sponsor signal, chemistry takeaway, capacity pull, LOI hint…"
            disabled={pending}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e); }}
          />
          <div className="row-input-actions">
            {err && <span className="row-input-err">{err}</span>}
            <button className="btn btn-submit" onClick={submit} disabled={pending || !draft.trim()}>
              {pending ? 'Re-ranking…' : 'Submit & re-rank'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- source verification ----------
function SourceChip({ source, docs }) {
  if (!source) return <span className="src-chip src-chip-unverified">Unverified, no source on file</span>;
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
  if (source.kind === 'ai_inferred') return <span className="src-chip src-chip-unverified">AI inferred, verify</span>;
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
export function BuyerModal({ buyer, onClose, onAdvance, onDrop, onDelete, onAppendNote, onRemoveNote, onLogEvent, onRescanBuyer, winnerPct }) {
  if (!buyer) return null;
  const isDropped = buyer.stage === "dropped";
  // Single displayed probability, winner-allocated share (P this buyer wins
  // the deal). Across all live buyers + no-deal pct = 100%. We no longer surface
  // the AI's standalone stage-aware probability separately; stage discipline
  // still constrains the AI in the prompt but doesn't appear as a competing UI
  // number.
  const prob = isDropped ? 0 : (winnerPct ?? probabilityFor(buyer));
  const noteLog = Array.isArray(buyer.noteLog) ? buyer.noteLog : [];
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [aiError, setAiError] = useState(null);
  useEffect(() => { setDraft(''); setAiError(null); }, [buyer.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Append a new note entry, persist it, then trigger a per-buyer rescan that
  // is tagged with the new note's id. The note survives even if the rescan
  // fails, persistence happens before the AI call. The aiHistory entry that
  // comes back is matched to this note via triggered_by_note_id so the
  // timeline can show "AI re-scored after this note" inline.
  const submitNote = async () => {
    const text = draft.trim();
    if (!text || pending) return;
    setPending(true);
    setAiError(null);
    const newNoteId = onAppendNote ? onAppendNote(buyer.id, text, null) : null;
    setDraft('');
    if (!onRescanBuyer) {
      setPending(false);
      return;
    }
    try {
      await onRescanBuyer(buyer.id, { triggerNoteId: newNoteId });
    } catch (e) {
      setAiError(e.message || "Re-scan failed");
    } finally {
      setPending(false);
    }
  };

  // One-click stage event from a chip (NDA signed, Chemistry scheduled,
  // LOI received, Declined). The parent's onLogEvent atomically appends a
  // canonical note + sets structural fields + advances stage, then triggers
  // a single rescan tagged with the new note's id. Chip clicks intentionally
  // ignore the textarea draft so any in-progress freetext stays put.
  const handleChip = async (eventKey) => {
    if (pending || !onLogEvent) return;
    setPending(true);
    setAiError(null);
    try {
      await onLogEvent(buyer.id, eventKey);
    } catch (e) {
      setAiError(e.message || "Re-scan failed");
    } finally {
      setPending(false);
    }
  };

  // Delete a past note, then rescan so the AI re-grounds without it. The
  // confirm prevents accidental clicks on the small × button.
  const deleteNote = async (noteId, preview) => {
    if (pending || !onRemoveNote) return;
    const ok = window.confirm(`Delete this note?\n\n"${preview.slice(0, 120)}${preview.length > 120 ? '…' : ''}"\n\nThe buyer will be re-analyzed without it.`);
    if (!ok) return;
    setPending(true);
    setAiError(null);
    onRemoveNote(buyer.id, noteId);
    if (!onRescanBuyer) {
      setPending(false);
      return;
    }
    try {
      await onRescanBuyer(buyer.id);
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
            <div className="modal-eyebrow">
              Buyer
              {typeof buyer.top100_rank === 'number' && (
                <span className="top100-badge top100-badge-modal" title={`Business Insurance · 100 Largest Brokers of U.S. Business (July/August 2025) · rank #${buyer.top100_rank}`}>#{buyer.top100_rank}</span>
              )}
              {buyer.top100_rank === null && (
                <span className="top100-badge top100-badge-modal top100-badge-nr" title="Not in Business Insurance's 100 Largest Brokers of U.S. Business (July/August 2025)">NR</span>
              )}
              {buyer.pe_backed && (
                <span className="pe-badge pe-badge-modal" title={`PE-backed${buyer.sponsor ? ` · ${buyer.sponsor}` : ''}`}>PE</span>
              )}
            </div>
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

        <div className="modal-summary">
          <div className="modal-summary-head">
            <span className="modal-summary-prob">{prob}<span>%</span></span>
            <span className="modal-summary-prob-label">chance of winning</span>
            {buyer.lastAnalyzed && (
              <span className="modal-summary-meta">· updated {new Date(buyer.lastAnalyzed).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            )}
          </div>
          {buyer.thesis ? (
            <div className="modal-summary-text">{buyer.thesis}</div>
          ) : (
            <span className="research-empty">No AI rescan yet, click Update from the top bar.</span>
          )}
        </div>

        <div className="modal-notes-block">
          <div className="modal-card-label">Field notes <span className="modal-card-hint">Each note re-analyzes the buyer</span></div>
          {!isDropped && onLogEvent && (
            <div className="chip-row">
              {Object.entries(EVENT_SPECS).map(([key, spec]) => (
                <button
                  key={key}
                  type="button"
                  className="chip"
                  disabled={pending || buyer.stage === 'closed'}
                  onClick={() => handleChip(key)}
                  title={`Stamp "${spec.text}"${spec.field ? ` · sets ${spec.field} to today` : ''}${spec.stage ? ` · advances stage to ${spec.stage}` : ''}`}
                >{spec.label}</button>
              ))}
            </div>
          )}
          <textarea
            className="notes-area"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            placeholder="Log buyer feedback, market signals, chemistry takeaways…"
            disabled={pending}
          />
          <div className="notes-actions">
            <button
              className="btn btn-submit"
              onClick={submitNote}
              disabled={pending || !draft.trim()}
            >
              {pending ? "Analyzing…" : "Add note & re-analyze"}
            </button>
          </div>
          {aiError && (
            <div className="notes-insight notes-insight-err">
              <div className="notes-insight-tag">Re-scan failed</div>
              <div className="notes-insight-text">{aiError}</div>
            </div>
          )}
          {noteLog.length > 0 && (
            <ul className="notes-timeline">
              {noteLog.slice().reverse().map(entry => (
                <li key={entry.id} className="notes-entry">
                  <div className="notes-entry-head">
                    <span className="notes-entry-time" title={new Date(entry.ts).toLocaleString()}>{relativeTime(entry.ts)}</span>
                    {onRemoveNote && (
                      <button
                        className="notes-entry-delete"
                        onClick={() => deleteNote(entry.id, entry.text)}
                        disabled={pending}
                        title="Delete this note (re-analyzes the buyer)"
                        aria-label="Delete note"
                      >×</button>
                    )}
                  </div>
                  <div className="notes-entry-text">{entry.text}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Conversation panel ----------
// Two-way chat with the AI advisor. User talks → AI replies in plain English
// and applies tools that mutate pipeline state (notes, stage moves,
// probability overrides, global intel). After any state-changing tool call,
// a full rescan runs automatically so every score reflects the new input.
// The thread is persistent (localStorage) so the running advisor relationship
// survives page reloads. Compact by default, last message preview + input;
// click to expand the full thread.
const CONVO_STORAGE_KEY = 'kennion.convo.v1';
const CONVO_VALID_STAGES = ['outreach', 'nda', 'chemistry', 'loi', 'closed', 'dropped'];

const CONVO_TOOLS = [
  {
    name: 'add_buyer_note',
    description: 'Append a piece of field intel to a specific buyer\'s timeline. Use when the user is telling you something about that buyer, feedback, signals, calls, document references.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_id: { type: 'string', description: 'Buyer id (lowercase short id like "hub", "onedigital").' },
        note: { type: 'string', description: 'The intel preserving the user\'s wording with light grammar cleanup.' },
      },
      required: ['buyer_id', 'note'],
    },
  },
  {
    name: 'append_global_intel',
    description: 'Log pipeline-wide intel that does not belong to any single buyer, market commentary, process observations, sector multiples shifting, corrections to global assumptions. Persists across rescans as running market context.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'The pipeline-wide intel.' },
      },
      required: ['note'],
    },
  },
  {
    name: 'set_buyer_stage',
    description: 'Move a buyer to a new stage. Only call when the user is explicit ("advance Hub to NDA", "drop Marsh"). Stages: outreach → nda → chemistry → loi → closed. "dropped" is the kill state. Always include a short reason capturing why the user changed it, this becomes durable training context for future rescans.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_id: { type: 'string' },
        stage: { type: 'string', enum: CONVO_VALID_STAGES },
        reason: { type: 'string', description: 'One short sentence (max 20 words) capturing the user\'s reason for the change, in their words.' },
      },
      required: ['buyer_id', 'stage', 'reason'],
    },
  },
  {
    name: 'override_probability',
    description: 'Manually override a buyer\'s probability. Only call when the user explicitly asks ("set OneDigital to 40", "Hub should be lower, like 18"). Otherwise let the rescan reprice naturally based on the note you logged. Always include a short reason, this becomes durable training context for future rescans.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_id: { type: 'string' },
        probability: { type: 'number', description: 'Integer 1-95.' },
        reason: { type: 'string', description: 'One short sentence (max 20 words) capturing the user\'s reason for the override, in their words.' },
      },
      required: ['buyer_id', 'probability', 'reason'],
    },
  },
  {
    name: 'correct_buyer_website',
    description: 'Update a buyer\'s website URL when the user tells you the stored one is wrong ("Cason Group should be thecasongroup.com, not casongroup.com"). Always include a short reason so the change is logged as a durable override. Do NOT use this for general intel, only when the user is specifically correcting the website link.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_id: { type: 'string', description: 'Buyer id (lowercase short id like "cason", "oakbridge").' },
        website: { type: 'string', description: 'The corrected URL. Must start with https:// or http://.' },
        reason: { type: 'string', description: 'One short sentence (max 20 words) capturing the user\'s correction in their words.' },
      },
      required: ['buyer_id', 'website', 'reason'],
    },
  },
  {
    name: 'invalidate_pipeline_priors',
    description: 'Wipe stale workspace-level AI rationales (close-date rationale, projected close month, confidence rationale, clearing-price rationale, no-deal rationale) when the user pushes back on a claim that came from one of those fields ("you say one chemistry meeting set for May, not true" / "close date doesn\'t match"). The rationale text and close_estimate shown to you are YOUR OWN prior conclusions, not user-verified facts. Logs the user\'s correction as pipeline-wide intel and forces the auto-rescan to re-derive from clean state. Use this for pipeline-level pushback; for buyer-level pushback use invalidate_buyer_priors instead.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'The user\'s correction in their words, max 30 words. Logged as pipeline-wide intel so future rescans see the correction.' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'log_batch_event',
    description: 'Stamp a structural milestone across MULTIPLE buyers in one call. Use when the user states an event affecting multiple buyers in one message ("CIM delivered to IMA / OneDigital / Kelly on 5/14"; "chemistry meetings confirmed for OneDigital and Oakbridge"; "NDAs signed by Alliant and C&B last week"). The tool stamps the canonical event note + sets the structural date field on every named buyer, then triggers ONE consolidated rescan. Event keys map 1:1 to the chips in the buyer modal: nda_signed (sets nda_signed date + advances stage to nda), cim_delivered (sets cim_delivered date), chemistry_scheduled (sets chemistry_date + advances to chemistry), ioi_received (sets ioi_received date), loi_received (advances to loi), declined (advances to dropped, force). Only call when the user EXPLICITLY states the event; for soft/ambiguous intel ("X seems excited about chemistry") use add_buyer_note instead. If the event key is uncertain, ask the user before calling.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of buyer ids the event applies to (lowercase short ids like ["ima", "onedigital", "kelly"]). Must match the id field from the pipeline state above.',
        },
        event_key: {
          type: 'string',
          enum: ['nda_signed', 'cim_delivered', 'chemistry_scheduled', 'ioi_received', 'loi_received', 'declined'],
          description: 'Which structural milestone to stamp on each buyer. Maps to the chips in the buyer modal.',
        },
        reason: {
          type: 'string',
          description: 'Optional source attribution (e.g., "Reagan email 5/14"). If provided, appended as a follow-up note on each affected buyer for audit trail.',
        },
      },
      required: ['buyer_ids', 'event_key'],
    },
  },
  {
    name: 'invalidate_buyer_priors',
    description: 'Wipe stale AI-derived TEXT fields (thesis + last AI reasoning) on one or more buyers when the user pushes back on a claim that came from those text fields ("you say OneDigital is pure-benefits, not true" / "wrong reasoning about X"). The thesis and last AI reasoning shown to you below are YOUR OWN prior conclusions, not user-verified facts; when the user disputes them, do NOT defend or apologize, call this tool. It logs the user\'s correction as pipeline-wide intel and forces the auto-rescan that follows to re-derive thesis + reasoning from clean state. **DOES NOT update milestone date fields** (cim_delivered, nda_signed, chemistry_date, ioi_received) — the dashboard stage badge "NDA SIGNED · CIM SENT" reads those date fields, not the thesis, so clearing priors will NOT fix a wrong badge or a wrong-date timeline. For date corrections use log_batch_event. For stage corrections use set_buyer_stage.',
    input_schema: {
      type: 'object',
      properties: {
        buyer_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Buyer ids whose thesis + last AI reasoning should be cleared. Include any buyer whose prior conclusion depended on the disputed claim, not just the one the user named.',
        },
        reason: { type: 'string', description: 'The user\'s correction in their words, max 30 words. Logged as pipeline-wide intel so future rescans see the correction.' },
      },
      required: ['buyer_ids', 'reason'],
    },
  },
];

export function Conversation({ buyers, pinnedRules, globalIntel, market, rationales, ebitda, onAddBuyerNote, onAppendGlobal, onSetStage, onOverrideProbability, onInvalidatePriors, onInvalidatePipelinePriors, onCorrectWebsite, onLogBatchEvent, onRescanAll }) {
  const [messages, setMessages] = useState(() => {
    try {
      const saved = localStorage.getItem(CONVO_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const threadRef = useRef(null);
  const buyersRef = useRef(buyers);
  const pinnedRulesRef = useRef(pinnedRules);
  const globalIntelRef = useRef(globalIntel);
  const marketRef = useRef(market);
  const rationalesRef = useRef(rationales);
  const ebitdaRef = useRef(ebitda);
  buyersRef.current = buyers;
  pinnedRulesRef.current = pinnedRules;
  globalIntelRef.current = globalIntel;
  marketRef.current = market;
  rationalesRef.current = rationales;
  ebitdaRef.current = ebitda;

  useEffect(() => {
    try { localStorage.setItem(CONVO_STORAGE_KEY, JSON.stringify(messages.slice(-40))); } catch {}
  }, [messages]);

  useEffect(() => {
    if (expanded && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages, pending, expanded]);

  // Omniscient context: everything the rescan endpoint sees, the advisor sees
  // too. Mirroring the brain into the system prompt is the whole point, when
  // the user references buyer.thesis or buyer.aiNotes the advisor must be able
  // to read them. Keep this generous; Sonnet's context handles it.
  const buildSystem = () => {
    const liveBuyers = (buyersRef.current || []).filter(b => b.stage !== 'dropped');
    const ranked = [...liveBuyers].sort((a, b) => (b.probability || 0) - (a.probability || 0));
    const buyerCtx = ranked.map(b => {
      const recentNotes = (b.noteLog || []).slice(-4).map(n => `    [${(n.ts || '').slice(0,10)}] ${n.text}`).join('\n');
      const overrides = (b.overrides || []).slice(-3).map(o => `    [${(o.ts || '').slice(0,10)}] ${o.kind} ${o.from}→${o.to}: ${o.reason}`).join('\n');
      // thesis + aiNotes are AI-DERIVED prior conclusions (your own output from
      // earlier rescans), not user-verified facts. Labeling matters: when the
      // user disputes one of these, you should call invalidate_buyer_priors,
      // not defend the line.
      const reasoning = b.aiNotes ? `\n  AI-prior · last reasoning: ${b.aiNotes}` : '';
      const thesis = b.thesis ? `\n  AI-prior · thesis: ${b.thesis}` : '';
      const site = b.website ? `\n  website: ${b.website}` : '';
      return `- id="${b.id}" · ${b.name} · stage=${b.stage} · p=${b.probability ?? '?'}%${site}${thesis}${reasoning}${recentNotes ? `\n  Recent notes:\n${recentNotes}` : ''}${overrides ? `\n  Recent overrides:\n${overrides}` : ''}`;
    }).join('\n');

    const dropped = (buyersRef.current || []).filter(b => b.stage === 'dropped');
    const droppedCtx = dropped.length > 0
      ? `\n\nDropped buyers: ${dropped.map(b => `${b.name} (${b.id})`).join(', ')}`
      : '';

    const m = marketRef.current || {};
    const r = rationalesRef.current || {};
    const marketCtx = m.mid
      ? `EBITDA $${ebitdaRef.current}M · realistic ${m.mid.low?.toFixed?.(1)}–${m.mid.high?.toFixed?.(1)}× · conservative ${m.conservative?.low?.toFixed?.(1)}–${m.conservative?.high?.toFixed?.(1)}× · aggressive ${m.aggressive?.low?.toFixed?.(1)}–${m.aggressive?.high?.toFixed?.(1)}×`
      : `EBITDA $${ebitdaRef.current}M · market bands not yet set`;

    // Workspace rationales are AI-PRIOR like buyer thesis: your own
    // conclusions from earlier rescans, not user-verified facts. When the
    // user disputes the close date or any rationale text below, call
    // invalidate_pipeline_priors, do not defend.
    const dashboardCtx = [
      r.offer_estimate ? `AI-prior · first-offer month: ${r.offer_estimate}` : null,
      r.offer_date ? `AI-prior · offer-date rationale: ${r.offer_date}` : null,
      r.close_estimate ? `AI-prior · close month: ${r.close_estimate}` : null,
      r.close_date ? `AI-prior · close-date rationale: ${r.close_date}` : null,
      r.confidence ? `AI-prior · confidence rationale: ${r.confidence}` : null,
      r.clearing_price ? `AI-prior · clearing-price rationale: ${r.clearing_price}` : null,
      typeof r.p_no_deal === 'number' ? `AI-prior · p_no_deal: ${r.p_no_deal}%${r.p_no_deal_rationale ? ` (${r.p_no_deal_rationale})` : ''}` : null,
    ].filter(Boolean).join('\n  ');

    const rulesCtx = (pinnedRulesRef.current || []).length > 0
      ? `\n\nUser-pinned rules (always apply):\n${(pinnedRulesRef.current || []).map((r, i) => `${i + 1}. ${r.text}`).join('\n')}`
      : '';

    const intelCtx = (globalIntelRef.current || []).length > 0
      ? `\n\nPipeline-wide intel log (newest first):\n${(globalIntelRef.current || []).slice(-10).reverse().map(g => `- [${(g.ts || '').slice(0,10)}] ${g.text}`).join('\n')}`
      : '';

    return `You are the user's senior M&A advisor inside the Kennion Prediction Engine, the sell-side process for Kennion's Benefits Program (Reagan Consulting · Spring 2026). You have full visibility into the workspace state below, the same inputs the rescan engine sees on every Update. When the user references something they're seeing in the UI, read it from the context. Do not deny knowledge of user-provided facts (recent notes, overrides, pinned rules, pipeline intel) that appear below.

Speak like a sharp banker who knows the deal cold: direct, conversational, no fluff. Replies under 80 words, no markdown, no headers.

# Two kinds of context, treat them differently
- **User-provided** (recent notes, overrides, pinned rules, pipeline intel): authoritative. The user logged these; trust them.
- **AI-prior** (any line tagged \`AI-prior · …\`, buyer thesis, last reasoning, close month, close-date rationale, confidence rationale, clearing-price rationale, p_no_deal rationale): YOUR OWN prior conclusions from earlier rescans. These are drafts, not facts. The seed pipeline contained planted text that may not be true; older rescans may have anchored on stale data. When the user pushes back on one of these lines ("you say X is pure-benefits, not true" / "no chemistry meeting set" / "close date doesn't match"), do NOT defend the claim and do NOT just apologize, call the right invalidate tool with the user's correction as \`reason\`. The auto-rescan that follows re-derives from clean state.

When the user gives you intel, apply it via tools, do not just acknowledge it:
- buyer-specific facts → add_buyer_note
- general market / process / sector intel → append_global_intel
- explicit stage change requested → set_buyer_stage (always include reason)
- user pushes back on a stage field ("X hasn't signed NDA yet", "Y is not at chemistry", "Z is still at outreach", "we are waiting on NDA from W"): this IS a stage correction. Call set_buyer_stage to the correct stage with the user's correction as reason. Do not "make a note" instead, do not just acknowledge in prose. The wrong stage stays on the dashboard until the tool fires.
- explicit probability override requested → override_probability (always include reason)
- user corrects a buyer's website URL → correct_buyer_website (buyer_id + corrected URL + reason). Always actually call the tool, don't just say you'll update it.
- user disputes a buyer-level AI-prior (thesis / last reasoning) → invalidate_buyer_priors (every affected buyer + the correction as reason)
- user disputes a workspace-level AI-prior (close month, close-date / confidence / clearing-price / no-deal rationale) → invalidate_pipeline_priors (the correction as reason)
- user states a structural milestone affecting MULTIPLE buyers in one message ("CIM delivered to A, B, C on date" / "chemistry confirmed for X and Y" / "NDAs signed by Z and W") → log_batch_event ONCE with all buyer_ids + the event_key. Do NOT call add_buyer_note N times. Event keys: nda_signed, cim_delivered, chemistry_scheduled, ioi_received, loi_received, declined. Only call when the user explicitly states the event; for soft intel ("X seems excited") still use add_buyer_note. Single-buyer milestones can also use this tool with a one-element buyer_ids array.
- user states a CORRECTION to a milestone date for ONE buyer ("C&B CIM actually received 5/28" / "Alliant NDA was signed 5/14 not 5/16" / "chemistry was 6/4 not 6/3") → log_batch_event with buyer_ids=[that one buyer] + the event_key + the corrected date. This is the SAME tool whether you're stamping a new event or correcting a previously-stamped one — log_batch_event writes (or overwrites) the date field. **Do NOT use invalidate_buyer_priors for date corrections.** invalidate_buyer_priors only clears thesis + last AI reasoning text; it does NOT touch the cim_delivered / nda_signed / chemistry_date / ioi_received fields shown on the buyer row badge. The dashboard badge "NDA SIGNED · CIM SENT" reads those date fields, not the thesis text, so clearing priors will NOT fix a wrong-looking badge.

# Tool disambiguation cheat sheet (READ when picking a tool):
- "timeline wrong" + a date mentioned → log_batch_event (the dates are the timeline)
- "reasoning wrong" / "thesis wrong" / "explanation wrong" → invalidate_buyer_priors
- "stage wrong" / "X is at NDA not chemistry" → set_buyer_stage
- "probability wrong" → override_probability
- "close date wrong" / "you said September" → invalidate_pipeline_priors

# On pushback ("still not updated" / "still wrong"):
If the user pushes back AFTER you've already called a tool, DO NOT ask another clarifying question — the user has given you the info, you misread it last time. Instead:
1. Re-read what tool you actually called and what fields it writes.
2. Re-read what the user originally said. If they mentioned a DATE for a milestone, you almost certainly should have called log_batch_event for that milestone. Call it now.
3. If the user said "timeline" and you called invalidate_buyer_priors: that was wrong — invalidate_priors doesn't update dates. Call log_batch_event with the date the user originally gave.
4. If you genuinely can't identify the right tool from the prior message, ask ONE specific question naming the candidate tools ("did you mean update the CIM date stamp, or change a written rationale line?"). Not a generic "tell me more."

After tools run, a full pipeline rescan automatically rescores every buyer with the new input. In your reply, briefly state what you did and one sharp implication. If the input is genuinely ambiguous (which buyer? which stage?), ask one clarifying question instead of guessing, but if the user is pushing back on an AI-prior line, invalidating is rarely ambiguous: clear the priors and let the rescan re-derive, even if the user hasn't given you the corrected fact yet.

If the user asks a question without giving new intel, answer from the context below, no tools.

# Pipeline anchors
${marketCtx}${dashboardCtx ? `\n  ${dashboardCtx}` : ''}

# Live buyers (state, AI-prior lines are your own drafts, not user-verified facts)
${buyerCtx || '(none)'}${droppedCtx}${rulesCtx}${intelCtx}`;
  };

  const executeTool = (name, args) => {
    const cur = buyersRef.current;
    if (name === 'add_buyer_note') {
      const target = cur.find(b => b.id === args.buyer_id);
      if (!target) return `error: no buyer "${args.buyer_id}", valid: ${cur.map(b => b.id).join(', ')}`;
      onAddBuyerNote(args.buyer_id, args.note);
      return `ok: logged to ${target.name}`;
    }
    if (name === 'append_global_intel') {
      onAppendGlobal(args.note);
      return 'ok: logged as pipeline-wide intel';
    }
    if (name === 'set_buyer_stage') {
      const target = cur.find(b => b.id === args.buyer_id);
      if (!target) return `error: no buyer "${args.buyer_id}"`;
      if (!CONVO_VALID_STAGES.includes(args.stage)) return `error: invalid stage "${args.stage}"`;
      onSetStage(args.buyer_id, args.stage, args.reason);
      return `ok: ${target.name} → ${args.stage}`;
    }
    if (name === 'override_probability') {
      const target = cur.find(b => b.id === args.buyer_id);
      if (!target) return `error: no buyer "${args.buyer_id}"`;
      const p = Math.max(1, Math.min(95, Math.round(args.probability)));
      onOverrideProbability(args.buyer_id, p, args.reason);
      return `ok: ${target.name} probability → ${p}%`;
    }
    if (name === 'invalidate_pipeline_priors') {
      onInvalidatePipelinePriors(args.reason);
      return `ok: cleared stale workspace rationales (close date, confidence, clearing price, no-deal); logged correction as pipeline intel`;
    }
    if (name === 'correct_buyer_website') {
      const target = cur.find(b => b.id === args.buyer_id);
      if (!target) return `error: no buyer "${args.buyer_id}", valid: ${cur.map(b => b.id).join(', ')}`;
      const url = String(args.website || '').trim();
      if (!/^https?:\/\//i.test(url)) return `error: website must start with http:// or https://, got "${url}"`;
      onCorrectWebsite(args.buyer_id, url, args.reason);
      return `ok: ${target.name} website → ${url}`;
    }
    if (name === 'invalidate_buyer_priors') {
      const ids = Array.isArray(args.buyer_ids) ? args.buyer_ids : [];
      const valid = ids.filter(id => cur.some(b => b.id === id));
      if (valid.length === 0) return `error: no valid buyer ids, valid: ${cur.map(b => b.id).join(', ')}`;
      onInvalidatePriors(valid, args.reason);
      const names = valid.map(id => cur.find(b => b.id === id)?.name || id).join(', ');
      return `ok: cleared stale thesis + AI reasoning on ${names}; logged correction as pipeline intel`;
    }
    if (name === 'log_batch_event') {
      if (!onLogBatchEvent) return 'error: batch event handler not wired';
      const ids = Array.isArray(args.buyer_ids) ? args.buyer_ids : [];
      if (ids.length === 0) return 'error: buyer_ids array is empty';
      const valid = ids.filter(id => cur.some(b => b.id === id));
      if (valid.length === 0) return `error: no valid buyer ids, valid: ${cur.map(b => b.id).join(', ')}`;
      if (!EVENT_SPECS[args.event_key]) return `error: unknown event_key "${args.event_key}", valid: ${Object.keys(EVENT_SPECS).join(', ')}`;
      const skipped = ids.filter(id => !cur.some(b => b.id === id));
      onLogBatchEvent(valid, args.event_key, args.reason);
      const names = valid.map(id => cur.find(b => b.id === id)?.name || id).join(', ');
      const skipMsg = skipped.length > 0 ? ` (skipped unknown ids: ${skipped.join(', ')})` : '';
      return `ok: stamped ${args.event_key} on ${names}${skipMsg}`;
    }
    return `error: unknown tool "${name}"`;
  };

  const send = async () => {
    const q = input.trim();
    if (!q || pending) return;
    setInput('');
    setPending(true);
    setExpanded(true);

    const userMsg = { role: 'user', content: [{ type: 'text', text: q }] };
    let history = [...messages, userMsg];
    setMessages(history);

    let mutated = false;
    try {
      for (let i = 0; i < 5; i++) {
        const resp = await claudeChat({
          messages: history.map(m => ({ role: m.role, content: m.content })),
          system: buildSystem(),
          tools: CONVO_TOOLS,
        });
        const assistantMsg = { role: 'assistant', content: resp.content };
        history = [...history, assistantMsg];
        setMessages(history);

        if (resp.stop_reason !== 'tool_use') break;

        const toolUses = resp.content.filter(b => b.type === 'tool_use');
        const toolResults = toolUses.map(tu => {
          const res = executeTool(tu.name, tu.input);
          if (res.startsWith('ok:')) mutated = true;
          return { type: 'tool_result', tool_use_id: tu.id, content: res };
        });
        history = [...history, { role: 'user', content: toolResults }];
        setMessages(history);
      }
      if (mutated) {
        await onRescanAll(q);
      }
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', content: [{ type: 'text', text: `(advisor error: ${e.message})` }] }]);
    } finally {
      setPending(false);
    }
  };

  const clearThread = () => {
    if (messages.length === 0) return;
    if (!window.confirm('Clear the advisor thread? Pipeline state and notes are not affected.')) return;
    setMessages([]);
    setExpanded(false);
  };

  // Find the most recent assistant text block for the collapsed preview.
  const lastAssistantText = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'assistant') continue;
      const text = (messages[i].content || []).filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (text) return text;
    }
    return null;
  })();

  return (
    <div className="convo">
      <form className="convo-form" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea
          className="convo-input"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Talk to the advisor, log intel, ask questions, correct anything. Enter to send."
          disabled={pending}
        />
        <button type="submit" className="convo-send" disabled={pending || !input.trim()}>
          {pending ? 'Thinking…' : 'Send'}
        </button>
      </form>

      {(lastAssistantText || pending) && !expanded && (
        <div className="convo-preview" onClick={() => setExpanded(true)} title="Click to expand thread">
          <span className="convo-preview-tag">Advisor</span>
          <span className="convo-preview-text">
            {pending ? 'Thinking…' : lastAssistantText}
          </span>
          {messages.length > 0 && <span className="convo-preview-more">{messages.length} msgs ↓</span>}
        </div>
      )}

      {expanded && (
        <div className="convo-thread" ref={threadRef}>
          {messages.map((m, i) => {
            const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
            const isAllToolResults = blocks.every(b => b.type === 'tool_result');
            if (isAllToolResults) {
              return blocks.map((b, j) => {
                const ok = typeof b.content === 'string' && b.content.startsWith('ok:');
                return (
                  <div key={`${i}-${j}`} className="convo-msg convo-msg-tool">
                    <span className="convo-tool-mark" style={{ color: ok ? '#1f9d55' : '#c44' }}>{ok ? '✓' : '!'}</span>
                    <span>{typeof b.content === 'string' ? b.content.replace(/^(ok|error):\s*/, '') : 'applied'}</span>
                  </div>
                );
              });
            }
            return (
              <div key={i} className={'convo-msg convo-msg-' + m.role}>
                {m.role === 'assistant' && <span className="convo-msg-tag">Advisor</span>}
                {m.role === 'user' && <span className="convo-msg-tag convo-msg-tag-user">You</span>}
                <div className="convo-msg-body">
                  {blocks.map((b, j) => {
                    if (b.type === 'text') return <div key={j}>{b.text}</div>;
                    if (b.type === 'tool_use') {
                      return (
                        <div key={j} className="convo-tool-call">→ {b.name}({Object.entries(b.input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})</div>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            );
          })}
          {pending && (
            <div className="convo-msg convo-msg-assistant">
              <span className="convo-msg-tag">Advisor</span>
              <div className="convo-msg-body convo-thinking"><span></span><span></span><span></span></div>
            </div>
          )}
          <div className="convo-thread-actions">
            <button type="button" className="convo-thread-action" onClick={() => setExpanded(false)}>Collapse</button>
            {messages.length > 0 && (
              <button type="button" className="convo-thread-action" onClick={clearThread}>Clear thread</button>
            )}
          </div>
        </div>
      )}
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
    const ctx = ranked.map(b => `- id="${b.id}" · ${b.name} (${b.hq}, ${b.revenue}, stage=${b.stage}, p=${probabilityFor(b)}%), ${b.thesis}`).join("\n");
    const docNote = fileIds && fileIds.length > 0
      ? `\n\nThe user has uploaded ${fileIds.length} document${fileIds.length === 1 ? '' : 's'} to the library (CIM, LOIs, buyer emails, analysis, etc.) which are attached to this conversation. Reference them when relevant, quote specifics, cite which doc.`
      : '';
    return `You are the AI analyst inside the Kennion Prediction Engine, a private deal-tracking workspace for Kennion's sale of its Benefits Program, advised by Reagan Consulting. Be concise, opinionated, and specific. Reference buyers by name. Keep text responses under 90 words. No headers, no markdown.

You have tools to mutate the pipeline state. When the user asks you to update, advance, drop, set stages, log notes, or change probabilities, actually call the tools instead of just describing what you would do. After tool calls succeed, briefly confirm what changed.

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
    : syncStatus === 'offline' ? 'Server unavailable, using local only'
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
            setError('Persistence unavailable, connect Postgres on Railway to enable audit history.');
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
          Server-side log of every AI rescan call, inputs sent, outputs returned, web intel fetched, duration. Newest first.
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
                        {out.buyers.length} buyer update{out.buyers.length === 1 ? '' : 's'}{out.models?.openai ? ' · two-model' : ' · claude only'}
                      </summary>
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, borderLeft: '2px solid var(--rule)' }}>
                        {out.buyers.map(b => {
                          const cb = (out.models?.claude?.buyers || []).find(x => x.id === b.id);
                          const ob = (out.models?.openai?.buyers || []).find(x => x.id === b.id);
                          return (
                            <div key={b.id} style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                              <b style={{ color: 'var(--ink)' }}>{buyerById[b.id]?.name || b.id}</b>
                              {', '}
                              {cb && <span style={{ color: '#cc785c', fontFamily: 'var(--mono)', fontSize: 11, marginRight: 6 }}>C={cb.probability}%</span>}
                              {ob && <span style={{ color: '#10a37f', fontFamily: 'var(--mono)', fontSize: 11, marginRight: 6 }}>G={ob.probability}%</span>}
                              <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>avg={b.probability}%</span>
                              {b.reasoning && <div style={{ marginTop: 2, fontSize: 11.5, color: 'var(--ink-3)' }}>{b.reasoning}</div>}
                            </div>
                          );
                        })}
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

// ---------- Brain (audit + training cockpit) ----------
// Mirrors the rescan prompt in prompt order. Each section says either
// "editable, your changes hit the next Update" or "defined in code".
// The user sees exactly what Claude is being fed and can curate the
// editable parts.
export function PrintButton() {
  return (
    <button
      className="print-btn"
      onClick={() => window.print()}
      title="Save dashboard as PDF (use the Save as PDF option in the print dialog)"
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
      PDF
    </button>
  );
}

export function BrainButton({ onClick }) {
  return (
    <button
      className="brain-btn"
      onClick={onClick}
      title="AI Brain, see and edit what Claude uses to score every prediction"
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
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)' }}></span>
      Brain
    </button>
  );
}

function BrainSection({ num, title, badge, caption, count, defaultOpen, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="brain-section">
      <button type="button" className="brain-section-head" onClick={() => setOpen(o => !o)}>
        <span className="brain-section-num">{num}</span>
        <span className="brain-section-title">{title}</span>
        {badge && <span className={'brain-section-badge brain-section-badge-' + (badge === 'editable' ? 'edit' : 'lock')}>{badge}</span>}
        {typeof count === 'number' && <span className="brain-section-count">{count}</span>}
        <span className="brain-section-toggle">{open ? '▾' : '▸'}</span>
      </button>
      {caption && <div className="brain-section-caption">{caption}</div>}
      {open && <div className="brain-section-body">{children}</div>}
    </div>
  );
}

export function BrainModal({
  onClose, buyers, ebitda, caseMode, market, process, docs,
  pinnedRules, globalIntel,
  onAddPinnedRule, onUpdatePinnedRule, onDeletePinnedRule,
  onUpdateGlobalIntel, onDeleteGlobalIntel,
  onRemoveBuyerNote, onClearBuyerHistory,
  onOpenBuyer, onOpenLibrary, onRescanAll,
}) {
  const [newRule, setNewRule] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const live = (buyers || []).filter(b => b.stage !== 'dropped');
  const allNotes = (buyers || []).flatMap(b =>
    (Array.isArray(b.noteLog) ? b.noteLog : []).map(n => ({ ...n, buyerId: b.id, buyerName: b.name }))
  ).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

  const startEdit = (id, text) => { setEditingId(id); setEditingText(text); };
  const cancelEdit = () => { setEditingId(null); setEditingText(''); };
  const saveRuleEdit = () => {
    if (!editingId) return;
    onUpdatePinnedRule(editingId, editingText.trim());
    cancelEdit();
  };
  const saveIntelEdit = () => {
    if (editingId == null) return;
    const idx = parseInt(String(editingId).replace('intel_', ''), 10);
    if (Number.isFinite(idx)) onUpdateGlobalIntel(idx, editingText.trim());
    cancelEdit();
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 960 }}>
        <button className="modal-close" onClick={onClose}>×</button>
        <div className="modal-eyebrow">AI Brain</div>
        <div className="modal-title" style={{ fontSize: 30, marginBottom: 6 }}>What Claude sees on every Update</div>
        <div className="modal-sub" style={{ marginBottom: 18 }}>
          The model is stateless. Every prediction is built from the inputs below, in this order. Edit or delete the editable parts; the next Update reflects your changes. <button type="button" className="brain-update-link" onClick={() => onRescanAll()}>Run Update now →</button>
        </div>

        {/* 1. System rules */}
        <BrainSection
          num={1}
          title="System rules"
          badge="defined in code"
          caption="The senior-banker prompt: size-bucket multiples, stage probability anchors, output schema, multiples discipline. Lives in server.js. Edit requires a code change."
        >
          <ul className="brain-bullets">
            <li><b>Size buckets</b> · sub-$3M, $3–5M, $5–10M, $10–20M, $20–50M, $50M+. Each bucket has conservative / realistic / aggressive multiple bands.</li>
            <li><b>Stage discipline</b> · outreach rarely &gt;25% · NDA 10–35% · chemistry 15–45% · LOI 35–75% · closed 80–95%.</li>
            <li><b>Conservatism</b> · public comps (BRO, AON, MMC) discounted 3–5× for private mid-market, plus another 1–2× for captive/niche.</li>
            <li><b>Output schema</b> · per-buyer probability + fit + thesis + reasoning + confidence; pipeline-level close date + clearing price + p_no_deal rationales.</li>
          </ul>
          <div className="brain-footnote">Defined in <code>server.js</code> · <code>buildRescanSystemPrompt</code></div>
        </BrainSection>

        {/* 2. Pinned rules */}
        <BrainSection
          num={2}
          title="Pinned rules"
          badge="editable"
          caption={`Your always-on guardrails. Spliced into every rescan above pipeline intel. Use this to correct mistakes ("Hub rarely pays >9×"), enforce constraints ("don't compress timeline without LOI"), or pin domain truths the system prompt misses.`}
          count={pinnedRules?.length || 0}
          defaultOpen
        >
          <div className="brain-add-row">
            <input
              type="text"
              className="brain-add-input"
              value={newRule}
              onChange={(e) => setNewRule(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { onAddPinnedRule(newRule); setNewRule(''); } }}
              placeholder='e.g. "Hub rarely pays >9× regardless of EBITDA bucket"'
            />
            <button
              type="button"
              className="brain-add-btn"
              onClick={() => { onAddPinnedRule(newRule); setNewRule(''); }}
              disabled={!newRule.trim()}
            >Add rule</button>
          </div>
          {(!pinnedRules || pinnedRules.length === 0) ? (
            <div className="brain-empty">No pinned rules yet. Type one above to start steering predictions.</div>
          ) : (
            <ol className="brain-list brain-list-numbered">
              {pinnedRules.map(r => (
                <li key={r.id} className="brain-row">
                  {editingId === r.id ? (
                    <>
                      <input
                        type="text"
                        className="brain-edit-input"
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Enter') saveRuleEdit(); if (e.key === 'Escape') cancelEdit(); }}
                      />
                      <button type="button" className="brain-row-btn" onClick={saveRuleEdit}>Save</button>
                      <button type="button" className="brain-row-btn" onClick={cancelEdit}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="brain-row-text">{r.text}</span>
                      <button type="button" className="brain-row-btn" onClick={() => startEdit(r.id, r.text)}>Edit</button>
                      <button type="button" className="brain-row-del" onClick={() => onDeletePinnedRule(r.id)} title="Delete rule">×</button>
                    </>
                  )}
                </li>
              ))}
            </ol>
          )}
        </BrainSection>

        {/* 3. Anchors */}
        <BrainSection
          num={3}
          title="Anchors"
          badge="defined in code"
          caption="The numeric anchors fed every rescan: your EBITDA, the size bucket it implies, current market bands, public broker comps. EBITDA is editable in the top bar; market bands are AI-set on every Update."
        >
          <div className="brain-grid">
            <div><b>EBITDA</b><br/>${ebitda}M</div>
            <div><b>Case mode</b><br/>{caseMode}</div>
            <div><b>Phase</b><br/>{process?.phase || '(auto)'}</div>
            <div><b>Conservative</b><br/>{market?.conservative ? `${market.conservative.low.toFixed(1)}–${market.conservative.high.toFixed(1)}×` : '-'}</div>
            <div><b>Realistic</b><br/>{market?.mid ? `${market.mid.low.toFixed(1)}–${market.mid.high.toFixed(1)}×` : '-'}</div>
            <div><b>Aggressive</b><br/>{market?.aggressive ? `${market.aggressive.low.toFixed(1)}–${market.aggressive.high.toFixed(1)}×` : '-'}</div>
          </div>
          <div className="brain-footnote">Public broker comps (BRO, AON, MMC, AJG, WTW, BWIN) injected from <code>src/data/precedents.js</code>.</div>
        </BrainSection>

        {/* 4. Buyers */}
        <BrainSection
          num={4}
          title="Buyers"
          badge="editable"
          caption="Each live buyer's profile + note timeline + last AI reasoning + manual overrides. This is the bulk of what the model sees per rescan. Click a buyer to edit; clear AI history when you want a buyer to start with a clean reasoning slate."
          count={live.length}
          defaultOpen
        >
          {live.length === 0 ? (
            <div className="brain-empty">No live buyers.</div>
          ) : (
            <table className="brain-table">
              <thead>
                <tr>
                  <th>Buyer</th>
                  <th>Stage</th>
                  <th>P</th>
                  <th>Notes</th>
                  <th>Overrides</th>
                  <th>AI hist</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {live.map(b => (
                  <tr key={b.id}>
                    <td><button type="button" className="brain-link" onClick={() => onOpenBuyer(b.id)}>{b.name}</button></td>
                    <td>
                      {b.stage}
                      {b.stage === 'nda' && b.cim_delivered && <span className="brain-substage"> · CIM SENT</span>}
                      {b.stage === 'chemistry' && b.ioi_received && <span className="brain-substage"> · IOI</span>}
                    </td>
                    <td>{b.probability ?? '?'}%</td>
                    <td>{(b.noteLog || []).length}</td>
                    <td>{(b.overrides || []).length}</td>
                    <td>{(b.aiHistory || []).length}</td>
                    <td><button type="button" className="brain-row-btn" onClick={() => onClearBuyerHistory(b.id)} title="Clear AI reasoning history for this buyer">Clear</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </BrainSection>

        {/* 5. All buyer notes (flat) */}
        <BrainSection
          num={5}
          title="All buyer notes"
          badge="editable"
          caption="Every note across every buyer, newest first. The AI sees these per-buyer in the rescan. Delete noisy or outdated ones if they were poisoning the predictions."
          count={allNotes.length}
        >
          {allNotes.length === 0 ? (
            <div className="brain-empty">No notes anywhere yet.</div>
          ) : (
            <ul className="brain-list">
              {allNotes.slice(0, 200).map(n => (
                <li key={`${n.buyerId}_${n.id}`} className="brain-row brain-row-note">
                  <button type="button" className="brain-chip brain-link" onClick={() => onOpenBuyer(n.buyerId)}>{n.buyerName}</button>
                  <span className="brain-row-time">{relativeTime(n.ts)}</span>
                  <span className="brain-row-text">{n.text}</span>
                  <button type="button" className="brain-row-del" onClick={() => onRemoveBuyerNote(n.buyerId, n.id)} title="Delete note">×</button>
                </li>
              ))}
            </ul>
          )}
        </BrainSection>

        {/* 6. Pipeline intel */}
        <BrainSection
          num={6}
          title="Pipeline intel log"
          badge="editable"
          caption="Process-wide observations not tied to any single buyer (market shifts, sector commentary). Add via the Conversation panel above the pipeline. Edit/delete here. Last 20 entries fed into every rescan."
          count={(globalIntel || []).length}
          defaultOpen
        >
          {(!globalIntel || globalIntel.length === 0) ? (
            <div className="brain-empty">No pipeline intel yet. Talk to the advisor about market or process observations to populate this.</div>
          ) : (
            <ul className="brain-list">
              {globalIntel.slice().reverse().map((g, revIdx) => {
                const idx = globalIntel.length - 1 - revIdx;
                const editId = `intel_${idx}`;
                return (
                  <li key={idx} className="brain-row">
                    {editingId === editId ? (
                      <>
                        <input
                          type="text"
                          className="brain-edit-input"
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          autoFocus
                          onKeyDown={(e) => { if (e.key === 'Enter') saveIntelEdit(); if (e.key === 'Escape') cancelEdit(); }}
                        />
                        <button type="button" className="brain-row-btn" onClick={saveIntelEdit}>Save</button>
                        <button type="button" className="brain-row-btn" onClick={cancelEdit}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <span className="brain-row-time">{relativeTime(g.ts)}</span>
                        <span className="brain-row-text">{g.text}</span>
                        <button type="button" className="brain-row-btn" onClick={() => startEdit(editId, g.text)}>Edit</button>
                        <button type="button" className="brain-row-del" onClick={() => onDeleteGlobalIntel(idx)} title="Delete intel">×</button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </BrainSection>

        {/* 7. Documents */}
        <BrainSection
          num={7}
          title="Documents"
          badge="editable in Library"
          caption="PDFs, CIMs, LOIs, term sheets attached via the Library. The model reads these as evidence on every rescan, hard documents (LOIs, term sheets) directly anchor multiple_override and confidence."
          count={(docs || []).length}
        >
          {(!docs || docs.length === 0) ? (
            <div className="brain-empty">No documents attached.</div>
          ) : (
            <ul className="brain-list">
              {docs.map(d => (
                <li key={d.id} className="brain-row">
                  <span className="brain-row-text">📎 {d.filename || d.name || d.id}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="brain-add-btn" style={{ marginTop: 8 }} onClick={onOpenLibrary}>Open Library →</button>
        </BrainSection>
      </div>
    </div>
  );
}
