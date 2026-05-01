// AI engine — single source of truth for all AI-driven evaluation calls.
//
// Three trigger points all share /api/ai/rescan:
//   - rescanPipeline()  → top-bar "Re-scan" button (full pipeline + market bands)
//   - rescanBuyer(id)   → buyer-modal "Submit & re-analyze" (notes change one buyer)
//   - rescanBuyers(ids) → library doc-classify post-step (rescore tagged buyers)
//
// The engine validates the AI response against a schema before returning,
// so callers never apply malformed updates to state.

const RESCAN_URL = '/api/ai/rescan';

// ---------- validation ----------

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function isInt(x, lo, hi) { return Number.isInteger(x) && x >= lo && x <= hi; }
function isStr(x) { return typeof x === 'string'; }

function validateMarketBand(b) {
  return b && isNum(b.low) && isNum(b.high) && b.low > 0 && b.high >= b.low && isStr(b.note);
}

function validateMarket(m) {
  return m && validateMarketBand(m.conservative) && validateMarketBand(m.mid) && validateMarketBand(m.aggressive);
}

function validateMultipleOverride(o) {
  if (o == null) return true; // null is valid (most buyers)
  if (typeof o !== 'object') return false;
  if (!isNum(o.low) || !isNum(o.mid) || !isNum(o.high)) return false;
  if (o.low > o.mid || o.mid > o.high || o.low <= 0 || o.high > 30) return false;
  if (!isStr(o.source) || !isStr(o.evidence)) return false;
  return true;
}

function validateBuyer(b) {
  if (!b || !isStr(b.id)) return false;
  if (!isInt(b.probability, 0, 100)) return false;
  if (!b.fit || !isInt(b.fit.size, 0, 5) || !isInt(b.fit.benefits, 0, 5) || !isInt(b.fit.pe, 0, 1) || !isInt(b.fit.precedent, 0, 5)) return false;
  if (!isStr(b.thesis) || !isStr(b.reasoning)) return false;
  if (!Array.isArray(b.cited_precedents) || b.cited_precedents.length === 0) return false;
  if (!validateMultipleOverride(b.multiple_override)) return false;
  return true;
}

function validateRescan(payload) {
  if (!payload || !validateMarket(payload.market)) return { ok: false, error: 'invalid market shape' };
  if (!Array.isArray(payload.buyers) || payload.buyers.length === 0) return { ok: false, error: 'missing buyers' };
  for (const b of payload.buyers) {
    if (!validateBuyer(b)) return { ok: false, error: `invalid buyer: ${b?.id || '<unknown>'}` };
  }
  if (!isStr(payload.summary)) return { ok: false, error: 'missing summary' };
  return { ok: true };
}

// ---------- diff helpers (for audit trail + UI feedback) ----------

export function diffBuyer(prev, next) {
  if (!prev) return { kind: 'new' };
  const changes = {};
  if (prev.probability !== next.probability) changes.probability = [prev.probability, next.probability];
  if (prev.thesis !== next.thesis) changes.thesis = [prev.thesis, next.thesis];
  if (JSON.stringify(prev.fit) !== JSON.stringify(next.fit)) changes.fit = [prev.fit, next.fit];
  const prevOv = prev.multipleOverride || null;
  const nextOv = next.multiple_override || null;
  if (JSON.stringify(prevOv) !== JSON.stringify(nextOv)) changes.multipleOverride = [prevOv, nextOv];
  return changes;
}

// ---------- core call ----------

async function callRescan({ buyers, ebitda, fileIds, onlyBuyerId, priorMarket }) {
  const res = await fetch(RESCAN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buyers,
      ebitda,
      file_ids: fileIds || [],
      only_buyer_id: onlyBuyerId || null,
      prior_market: priorMarket,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `rescan failed (${res.status})`);
  }
  const data = await res.json();
  const v = validateRescan(data);
  if (!v.ok) throw new Error(`AI returned malformed output: ${v.error}`);
  return data;
}

// ---------- state merging ----------

// Merge a rescan response into the buyer list. Each updated buyer gets:
//   - new multiple/probability/fit/thesis values
//   - aiNotes (the reasoning string from this rescan)
//   - aiCitations (evidence list)
//   - lastAnalyzed (timestamp)
//   - aiHistory entry appended (capped at 8 entries, oldest dropped)
export function applyRescanToBuyers(buyers, rescan) {
  const byId = Object.fromEntries(rescan.buyers.map(b => [b.id, b]));
  return buyers.map(b => {
    const upd = byId[b.id];
    if (!upd) return b;
    const changes = diffBuyer(b, upd);
    const historyEntry = {
      ts: rescan.ts || new Date().toISOString(),
      reasoning: upd.reasoning,
      changes,
    };
    const aiHistory = [...(b.aiHistory || []), historyEntry].slice(-8);
    return {
      ...b,
      probability: upd.probability,
      fit: upd.fit,
      thesis: upd.thesis,
      multipleOverride: upd.multiple_override || null,
      aiNotes: upd.reasoning,
      aiCitations: upd.citations || [],
      aiCitedPrecedents: upd.cited_precedents || [],
      lastAnalyzed: rescan.ts || new Date().toISOString(),
      aiHistory,
    };
  });
}

// ---------- public API ----------

export async function rescanPipeline({ buyers, ebitda, fileIds, priorMarket }) {
  return callRescan({ buyers, ebitda, fileIds, priorMarket });
}

export async function rescanBuyer({ buyers, ebitda, fileIds, priorMarket, buyerId }) {
  return callRescan({ buyers, ebitda, fileIds, priorMarket, onlyBuyerId: buyerId });
}

export async function rescanBuyers({ buyers, ebitda, fileIds, priorMarket, buyerIds }) {
  // Run sequentially to avoid blowing through the rate limit and to keep
  // each call's prior_market consistent.
  let workingBuyers = buyers;
  let lastMarket = priorMarket;
  let lastSummary = '';
  for (const id of buyerIds) {
    const result = await callRescan({
      buyers: workingBuyers,
      ebitda,
      fileIds,
      priorMarket: lastMarket,
      onlyBuyerId: id,
    });
    workingBuyers = applyRescanToBuyers(workingBuyers, result);
    lastSummary = result.summary;
  }
  return {
    buyers: workingBuyers,
    summary: lastSummary,
    ts: new Date().toISOString(),
  };
}

export function fmtMetaFromRescan(rescan, n) {
  const t = new Date(rescan.ts || Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `AI · re-scored ${n} buyer${n === 1 ? '' : 's'} · ${t}`;
}
