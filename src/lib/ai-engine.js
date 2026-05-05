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
  if (!validateMultipleOverride(b.multiple_override)) return false;
  // confidence is optional for backwards-compat with logs from before the
  // schema added it; if present it must be one of the three buckets.
  if (b.confidence != null && !['low', 'medium', 'high'].includes(b.confidence)) return false;
  return true;
}

function validateRescan(payload) {
  if (!payload || !validateMarket(payload.market)) return { ok: false, error: 'invalid market shape' };
  if (!Array.isArray(payload.buyers) || payload.buyers.length === 0) return { ok: false, error: 'missing buyers' };
  for (const b of payload.buyers) {
    if (!validateBuyer(b)) return { ok: false, error: `invalid buyer: ${b?.id || '<unknown>'}` };
  }
  if (!isStr(payload.summary)) return { ok: false, error: 'missing summary' };
  if (!isStr(payload.close_date_rationale)) return { ok: false, error: 'missing close_date_rationale' };
  if (!isStr(payload.confidence_rationale)) return { ok: false, error: 'missing confidence_rationale' };
  if (!isStr(payload.clearing_price_rationale)) return { ok: false, error: 'missing clearing_price_rationale' };
  // p_no_deal + close_estimate are optional on per-buyer rescans (server only
  // requires them on pipeline-wide calls); when present they must be valid.
  if (payload.p_no_deal != null && !isInt(payload.p_no_deal, 0, 100)) {
    return { ok: false, error: 'p_no_deal out of range' };
  }
  if (payload.close_estimate != null && !/^\d{4}-\d{1,2}$/.test(String(payload.close_estimate))) {
    return { ok: false, error: 'close_estimate not in YYYY-MM format' };
  }
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

async function callRescan({ buyers, ebitda, fileIds, onlyBuyerId, priorMarket, globalIntel, extraIntel, pinnedRules }) {
  const res = await fetch(RESCAN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      buyers,
      ebitda,
      file_ids: fileIds || [],
      only_buyer_id: onlyBuyerId || null,
      prior_market: priorMarket,
      global_intel: globalIntel || [],
      extra_intel: extraIntel || null,
      pinned_rules: pinnedRules || [],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error || `rescan failed (${res.status})`;
    const e = new Error(msg);
    e.status = res.status;
    e.type = err.type || null;
    e.requestId = err.request_id || null;
    throw e;
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
// opts.trigger: { buyerId, noteId } — when present, the aiHistory entry for
// that buyer is tagged so the timeline UI can show "AI re-scored after this note".
export function applyRescanToBuyers(buyers, rescan, opts = {}) {
  const trigger = opts.trigger || null;
  const byId = Object.fromEntries(rescan.buyers.map(b => [b.id, b]));
  // Per-buyer Claude vs OpenAI probabilities so each row can show the
  // dual-model vote (same pattern as HeroKPIs ModelVote chips). The blended
  // (averaged) value lands in upd.probability above; these are the raw votes.
  const claudeById = Object.fromEntries(((rescan.models?.claude?.buyers) || []).map(b => [b.id, b]));
  const openaiById = Object.fromEntries(((rescan.models?.openai?.buyers) || []).map(b => [b.id, b]));
  return buyers.map(b => {
    const upd = byId[b.id];
    if (!upd) return b;
    const changes = diffBuyer(b, upd);
    const historyEntry = {
      ts: rescan.ts || new Date().toISOString(),
      reasoning: upd.reasoning,
      changes,
      ...(trigger && trigger.buyerId === b.id && trigger.noteId
        ? { triggered_by_note_id: trigger.noteId }
        : {}),
    };
    const aiHistory = [...(b.aiHistory || []), historyEntry].slice(-8);
    const cp = claudeById[b.id]?.probability;
    const op = openaiById[b.id]?.probability;
    const modelVote = (typeof cp === 'number' || typeof op === 'number')
      ? { claude: typeof cp === 'number' ? cp : null, openai: typeof op === 'number' ? op : null, avg: upd.probability }
      : null;
    return {
      ...b,
      probability: upd.probability,
      fit: upd.fit,
      thesis: upd.thesis,
      multipleOverride: upd.multiple_override || null,
      aiNotes: upd.reasoning,
      aiConfidence: upd.confidence || null,
      aiCitations: upd.citations || [],
      lastAnalyzed: rescan.ts || new Date().toISOString(),
      aiHistory,
      modelVote,
    };
  });
}

// ---------- public API ----------

export async function rescanPipeline({ buyers, ebitda, fileIds, priorMarket, globalIntel, extraIntel, pinnedRules }) {
  return callRescan({ buyers, ebitda, fileIds, priorMarket, globalIntel, extraIntel, pinnedRules });
}

export async function rescanBuyer({ buyers, ebitda, fileIds, priorMarket, buyerId, globalIntel, extraIntel, pinnedRules }) {
  return callRescan({ buyers, ebitda, fileIds, priorMarket, onlyBuyerId: buyerId, globalIntel, extraIntel, pinnedRules });
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
  const intel = rescan.live_intel_used ? ' · live web intel' : '';
  return `AI · re-scored ${n} buyer${n === 1 ? '' : 's'}${intel} · ${t}`;
}
