import { useState, useEffect, useRef } from 'react';
import { STAGES, STAGE_INDEX, PROCESS_DEFAULT, BUYERS } from './data.js';
import {
  HeroKPIs, ProcessTracker, SystemBar, BuyerRow, BuyerModal,
  Conversation, winnerProbabilities, AIHistoryButton, AIHistoryModal,
  BrainButton, BrainModal,
} from './components.jsx';
import { LibraryButton, LibraryModal, useLibrary } from './Library.jsx';
import { rescanPipeline, rescanBuyer, rescanBuyers, applyRescanToBuyers, fmtMetaFromRescan } from './lib/ai-engine.js';
import { fetchWorkspace, pushWorkspace, pushBuyers, debouncedPush } from './lib/sync.js';
import { migrateNoteLog, appendNote, removeNote, latestNoteId, EVENT_SPECS } from './lib/notes.js';

const STATE_KEY = 'kennion.state.v1';

// Static identity fields backfilled from the BUYERS seed by id whenever a
// persisted buyer is missing them. Older code paths pushed buyer JSON to
// Postgres without `website` (and other identity bits), so the row UI was
// missing the website link even though data.js has it. These fields are
// firm-level facts that don't change — safe to fall back to seed when the
// stored copy is missing them. We don't overwrite values that are already
// present; user-edited identity (rare but possible) wins.
const SEED_BY_ID = Object.fromEntries(BUYERS.map(b => [b.id, b]));
const IDENTITY_FIELDS = ['name', 'website', 'hq', 'revenue', 'headcount', 'offices', 'type'];
function backfillIdentity(buyer) {
  const seed = SEED_BY_ID[buyer.id];
  if (!seed) return buyer;
  const patch = {};
  for (const k of IDENTITY_FIELDS) {
    if (buyer[k] == null || buyer[k] === '') patch[k] = seed[k];
  }
  return Object.keys(patch).length > 0 ? { ...buyer, ...patch } : buyer;
}

const DEFAULT_MARKET = {
  conservative: { low: 8.5,  high: 10.5, label: 'Conservative', note: 'Bear case · soft market' },
  mid:          { low: 11.0, high: 13.0, label: 'Realistic',     note: 'Base case · current signals' },
  aggressive:   { low: 13.5, high: 15.5, label: 'Aggressive',    note: 'Bull case · strategic premium' },
};

function loadState() {
  try {
    const saved = localStorage.getItem(STATE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    // Migration: drop legacy per-buyer multiple triples — pricing now lives
    // in the global market band. Buyers without firm evidence inherit it.
    if (Array.isArray(parsed.buyers)) {
      parsed.buyers = parsed.buyers.map(b => {
        const { multiple, multipleAdj, ...rest } = b;
        return { ...rest, multipleOverride: rest.multipleOverride ?? null };
      });
    }
    return parsed;
  } catch { return null; }
}

function usePersistedState(key, initial) {
  const saved = loadState();
  const [value, setValue] = useState(saved?.[key] !== undefined ? saved[key] : initial);
  useEffect(() => {
    try {
      const current = loadState() || {};
      current[key] = value;
      localStorage.setItem(STATE_KEY, JSON.stringify(current));
    } catch {}
  }, [key, value]);
  return [value, setValue];
}

export default function App() {
  const [buyers, setBuyersRaw] = usePersistedState('buyers', BUYERS);
  // Wrap setBuyers so any path that hydrates buyers (server fetch, persisted
  // state, AI rescan, manual edits) goes through the noteLog migration shim.
  // The shim is idempotent — buyers already with noteLog pass through.
  const setBuyers = (next) => {
    setBuyersRaw(prev => {
      const resolved = typeof next === 'function' ? next(prev) : next;
      return Array.isArray(resolved) ? resolved.map(b => backfillIdentity(migrateNoteLog(b))) : resolved;
    });
  };
  // One-shot migration of the initial state (covers BUYERS seed and persisted
  // localStorage values that were saved before noteLog existed). Also runs
  // the identity backfill so persisted buyers missing website/hq/etc. pick
  // them up from the seed.
  useEffect(() => {
    setBuyersRaw(prev => Array.isArray(prev) ? prev.map(b => backfillIdentity(migrateNoteLog(b))) : prev);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [process, setProcess] = usePersistedState('process', PROCESS_DEFAULT);
  const [ebitda, setEbitda] = usePersistedState('ebitda', 3.6);
  const [caseMode, setCaseMode] = usePersistedState('caseMode', 'mid');
  const [market, setMarket] = usePersistedState('market', DEFAULT_MARKET);
  const [marketMeta, setMarketMeta] = usePersistedState('marketMeta', 'AI · sector deal flow + public comp drift · 2 min ago');
  const [rationales, setRationales] = usePersistedState('rationales', { close_date: null, confidence: null, clearing_price: null, p_no_deal: null, p_no_deal_rationale: null });
  const [globalIntel, setGlobalIntel] = usePersistedState('globalIntel', []);
  const [pinnedRules, setPinnedRules] = usePersistedState('pinnedRules', []);

  const [openId, setOpenId] = useState(null);
  const [openIntent, setOpenIntent] = useState(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showBrain, setShowBrain] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [docs, setDocs] = useLibrary();
  const [rescanError, setRescanError] = useState(null);
  const [syncStatus, setSyncStatus] = useState('local'); // 'local' | 'syncing' | 'synced' | 'offline'
  const hydrated = useRef(false);

  const fileIds = docs.filter(d => !d.classifying).map(d => d.id);

  // Stale-while-revalidate hydration. localStorage already populated state
  // synchronously; we now reconcile with server. If server has newer
  // workspace state, replace local. Otherwise push local up so the device
  // that booted wins (single-tenant — last writer wins).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchWorkspace();
      if (cancelled) return;
      if (!result.available) {
        setSyncStatus('offline');
        hydrated.current = true;
        return;
      }
      if (result.workspace) {
        const ws = result.workspace;
        if (ws.ebitda != null) setEbitda(Number(ws.ebitda));
        if (ws.case_mode) setCaseMode(ws.case_mode);
        if (ws.market) setMarket(ws.market);
        if (ws.market_meta) setMarketMeta(ws.market_meta);
        if (ws.rationales) setRationales(ws.rationales);
        // The v3 scrub of workspace rationales is hoisted up here so it runs
        // even before the buyers branch (the rationale wipe should still
        // apply on a workspace that has rationales but no buyers yet).
        if (!localStorage.getItem('kennion.demoScrub.v4')) {
          setRationales({
            close_date: null,
            close_estimate: null,
            confidence: null,
            clearing_price: null,
            p_no_deal: null,
            p_no_deal_rationale: null,
          });
        }
        if (ws.process) setProcess(ws.process);
        if (Array.isArray(ws.global_intel)) setGlobalIntel(ws.global_intel);
        if (Array.isArray(ws.pinned_rules)) setPinnedRules(ws.pinned_rules);
      }
      if (Array.isArray(result.buyers) && result.buyers.length > 0) {
        // One-shot scrub of legacy demo seed fields (planted nda_signed,
        // chemistry_date, the legacy `notes` string, AI history, AI reasoning,
        // overrides). Runs once per browser, gated by a localStorage flag.
        // Identity fields and noteLog timeline entries are preserved.
        // v4 also force-refreshes the `website` field from the seed by id.
        // Previous seeds had wrong URLs for some firms (e.g. Oakbridge,
        // Cason) and the user couldn't correct them via the advisor — the
        // advisor said it would but had no tool. Now the seed is the
        // source of truth on first scrub; subsequent corrections via
        // correct_buyer_website override it.
        const SCRUB_KEY = 'kennion.demoScrub.v4';
        let cleaned = result.buyers;
        if (!localStorage.getItem(SCRUB_KEY)) {
          cleaned = result.buyers.map(b => {
            const seed = SEED_BY_ID[b.id];
            return {
              ...b,
              ...(seed ? { website: seed.website } : {}),
              nda_signed: null,
              chemistry_date: null,
              notes: '',
              thesis: null,
              aiHistory: [],
              aiNotes: null,
              aiCitations: [],
              overrides: [],
            };
          });
          try { localStorage.setItem(SCRUB_KEY, new Date().toISOString()); } catch {}
          // Push cleaned state back to Postgres so other devices see the scrub.
          pushBuyers(cleaned).catch(() => {});
        }
        setBuyers(cleaned);
      } else {
        // Server is empty — push our local state up as the seed.
        await pushBuyers(buyers);
        await pushWorkspace({
          ebitda, case_mode: caseMode, market, market_meta: marketMeta,
          rationales, process, global_intel: globalIntel,
          pinned_rules: pinnedRules,
        });
      }
      setSyncStatus('synced');
      hydrated.current = true;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write-through: every workspace-level change → debounced PUT to server.
  useEffect(() => {
    if (!hydrated.current) return;
    setSyncStatus('syncing');
    debouncedPush('workspace', async () => {
      const ok = await pushWorkspace({
        ebitda, case_mode: caseMode, market, market_meta: marketMeta,
        rationales, process, global_intel: globalIntel,
        pinned_rules: pinnedRules,
      });
      setSyncStatus(ok ? 'synced' : 'offline');
    });
  }, [ebitda, caseMode, market, marketMeta, rationales, process, globalIntel, pinnedRules]);

  // Buyers sync — bulk replace (rescans typically touch many buyers at once).
  useEffect(() => {
    if (!hydrated.current) return;
    setSyncStatus('syncing');
    debouncedPush('buyers', async () => {
      const ok = await pushBuyers(buyers);
      setSyncStatus(ok ? 'synced' : 'offline');
    });
  }, [buyers]);

  // Real pipeline-wide re-evaluation. Sends every non-dropped buyer + every
  // attached document + prior market bands to the AI, validates the response,
  // then merges new multiples / probabilities / fit / thesis into state.
  const captureRationales = (result) => {
    // Per-buyer rescans may legitimately omit pipeline-level fields; in that
    // case keep the prior values rather than wiping them. Spread current state
    // through a functional update so concurrent rescans don't trample.
    setRationales(prev => ({
      ...prev,
      close_date: result.close_date_rationale ?? prev.close_date ?? null,
      confidence: result.confidence_rationale ?? prev.confidence ?? null,
      clearing_price: result.clearing_price_rationale ?? prev.clearing_price ?? null,
      p_no_deal: typeof result.p_no_deal === 'number' ? result.p_no_deal : (prev.p_no_deal ?? null),
      p_no_deal_rationale: result.p_no_deal_rationale ?? prev.p_no_deal_rationale ?? null,
      close_estimate: result.close_estimate ?? prev.close_estimate ?? null,
      two_model: !!result.two_model,
      models: result.models || prev.models || null,
      ts: result.ts || new Date().toISOString(),
    }));
  };

  const rescanAll = async (extraIntel = null) => {
    setRescanError(null);
    try {
      const result = await rescanPipeline({
        buyers,
        ebitda,
        fileIds,
        priorMarket: market,
        globalIntel,
        extraIntel,
        pinnedRules,
      });
      setBuyers(bs => applyRescanToBuyers(bs, result));
      setMarket(result.market);
      setMarketMeta(fmtMetaFromRescan(result, result.buyers.length));
      captureRationales(result);
      return result;
    } catch (e) {
      setRescanError(e.message);
      throw e;
    }
  };

  // Per-buyer rescan — used by note submission and doc-tagged updates.
  // opts.triggerNoteId — when a rescan is triggered by a fresh note append,
  // pass the new note's id so applyRescanToBuyers tags the resulting
  // aiHistory entry. Lets the timeline UI show "AI re-scored after this note".
  const rescanOne = async (buyerId, opts = {}) => {
    setRescanError(null);
    try {
      const result = await rescanBuyer({
        buyers,
        ebitda,
        fileIds,
        priorMarket: market,
        buyerId,
        globalIntel,
        pinnedRules,
      });
      const trigger = opts.triggerNoteId
        ? { buyerId, noteId: opts.triggerNoteId }
        : null;
      setBuyers(bs => applyRescanToBuyers(bs, result, { trigger }));
      captureRationales(result);
      return result;
    } catch (e) {
      setRescanError(e.message);
      throw e;
    }
  };

  const rescanMany = async (buyerIds) => {
    if (!buyerIds || buyerIds.length === 0) return;
    setRescanError(null);
    try {
      const result = await rescanBuyers({
        buyers,
        ebitda,
        fileIds,
        priorMarket: market,
        buyerIds,
      });
      setBuyers(result.buyers);
      setMarketMeta(fmtMetaFromRescan(result, buyerIds.length));
      return result;
    } catch (e) {
      setRescanError(e.message);
      throw e;
    }
  };

  const open = buyers.find(b => b.id === openId);

  // Per-buyer "AI is re-scoring" flag, surfaced in the row + modal so users
  // see that the number reflects the new state, not the old one.
  const [rescanning, setRescanning] = useState({});

  const triggerRescanForStageChange = async (id) => {
    setRescanning(r => ({ ...r, [id]: true }));
    try {
      await rescanOne(id);
    } catch (_e) {
      // rescanOne already records rescanError state; nothing else to do here.
    } finally {
      setRescanning(r => {
        const { [id]: _, ...rest } = r;
        return rest;
      });
    }
  };

  const advance = (id) => {
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      const idx = STAGE_INDEX[b.stage];
      const next = STAGES[Math.min(idx + 1, STAGES.length - 1)];
      return { ...b, stage: next.id };
    }));
    triggerRescanForStageChange(id);
  };
  const drop = (id) => {
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, stage: 'dropped' } : b));
    triggerRescanForStageChange(id);
  };
  // Append a new note entry to a buyer's noteLog. Returns the new note id so
  // the caller can pass it through to a rescan as `triggerNoteId`. Optional
  // `signal` tags the entry with a user-judged trajectory classification.
  const appendBuyerNote = (id, text, signal) => {
    let newNoteId = null;
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      const next = appendNote(migrateNoteLog(b), text, signal ? { signal } : undefined);
      newNoteId = latestNoteId(next.noteLog);
      return next;
    }));
    return newNoteId;
  };

  // Remove a single note entry by id. The AI's prior reasoning may have
  // anchored on this note, so the modal triggers a rescan after deletion.
  const removeBuyerNote = (id, noteId) => {
    setBuyers(bs => bs.map(b => b.id === id ? removeNote(migrateNoteLog(b), noteId) : b));
  };

  // Stamp a structured stage event on a buyer in one atomic state update:
  // append the canonical note, set the structural field (nda_signed,
  // chemistry_date), and advance the stage if the target is later than
  // current (`force` overrides for terminal events like declined → dropped).
  // Returns the new note id so the caller can tag the rescan that follows.
  const logBuyerEvent = (id, eventKey) => {
    const spec = EVENT_SPECS[eventKey];
    if (!spec) return null;
    const today = new Date().toISOString().slice(0, 10);
    let newNoteId = null;
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      let next = appendNote(migrateNoteLog(b), spec.text);
      newNoteId = latestNoteId(next.noteLog);
      if (spec.field) {
        next = { ...next, [spec.field]: spec.value === '$today' ? today : spec.value };
      }
      if (spec.stage) {
        const cur = STAGE_INDEX[next.stage] ?? -1;
        const tgt = STAGE_INDEX[spec.stage] ?? -1;
        if (spec.force || tgt > cur) next = { ...next, stage: spec.stage };
      }
      return next;
    }));
    return newNoteId;
  };
  const deleteBuyer = (id) => {
    if (!window.confirm('Permanently delete this buyer from the pipeline? This cannot be undone.')) return;
    setBuyers(bs => bs.filter(b => b.id !== id));
    setOpenId(null);
  };
  const openBuyer = (id, intent = null) => { setOpenId(id); setOpenIntent(intent); };

  // Conversation handlers — buyer-specific intel goes into that buyer's
  // noteLog (so it shows up in the modal timeline + feeds future rescans).
  // General intel appends to workspace.globalIntel which the rescan endpoint
  // splices into every prompt as a running market-context log (capped at 50
  // client-side, 20 most-recent server-side).
  const routeIntelToBuyer = (buyerId, note) => {
    appendBuyerNote(buyerId, note);
  };
  const appendGlobalIntel = (text) => {
    setGlobalIntel(prev => {
      const next = [...(Array.isArray(prev) ? prev : []), { ts: new Date().toISOString(), text }];
      return next.slice(-50);
    });
  };
  // Override-with-reason: every manual stage/probability change captured as
  // structured override on the buyer so the next rescan sees "user overrode
  // X to Y because Z" — turns disagreement into durable training signal.
  const recordOverride = (id, entry) => {
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      const prior = Array.isArray(b.overrides) ? b.overrides : [];
      return { ...b, overrides: [...prior, { ...entry, ts: new Date().toISOString() }].slice(-20) };
    }));
  };
  const setBuyerStage = (id, stage, reason) => {
    let from = null;
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      from = b.stage;
      return { ...b, stage };
    }));
    if (reason) recordOverride(id, { kind: 'stage', from, to: stage, reason });
  };
  const overrideBuyerProbability = (id, probability, reason) => {
    let from = null;
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      from = b.probability;
      return { ...b, probability };
    }));
    if (reason) recordOverride(id, { kind: 'probability', from, to: probability, reason });
  };

  // Apply a website correction the advisor logged via the chat. We also
  // record an override entry so the next rescan sees "user corrected
  // website to X because Y" as durable training context, and the new URL
  // gets pushed to Postgres via the normal write-through.
  const correctBuyerWebsite = (id, website, reason) => {
    const target = buyers.find(b => b.id === id);
    if (!target) return false;
    const from = target.website || null;
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, website } : b));
    if (reason) recordOverride(id, { kind: 'website', from, to: website, reason });
    return true;
  };

  // Pipeline-level analogue of invalidateBuyerPriors. When the user pushes
  // back on a workspace-level AI claim (close-date rationale, confidence
  // rationale, clearing-price rationale, p_no_deal rationale, the projected
  // close month itself), wipe those rationale fields and log the correction
  // as global intel. The auto-rescan re-derives them.
  const invalidatePipelinePriors = (reason) => {
    setRationales(prev => ({
      ...prev,
      close_date: null,
      close_estimate: null,
      confidence: null,
      clearing_price: null,
      p_no_deal_rationale: null,
    }));
    if (reason) appendGlobalIntel(reason);
  };

  // When the user pushes back on something the advisor pulled from a buyer's
  // thesis or last AI reasoning ("you say X, not true"), wipe those AI-derived
  // fields on the affected buyers and log the user's correction as global
  // intel. The auto-rescan that follows the tool call re-derives thesis +
  // reasoning from clean state, so the next response can't re-anchor on the
  // stale claim. We only drop the most recent aiHistory entry (the one the
  // rescan endpoint replays as prior reasoning) to preserve the older audit
  // trail.
  const invalidateBuyerPriors = (buyerIds, reason) => {
    if (!Array.isArray(buyerIds) || buyerIds.length === 0) return;
    setBuyers(bs => bs.map(b => {
      if (!buyerIds.includes(b.id)) return b;
      const trimmedHistory = Array.isArray(b.aiHistory) ? b.aiHistory.slice(0, -1) : [];
      return { ...b, thesis: null, aiNotes: null, aiCitations: [], aiHistory: trimmedHistory };
    }));
    if (reason) appendGlobalIntel(reason);
  };

  // Brain handlers — pinned rules, lessons, and intel are all simple list
  // mutations that flow through the existing workspace write-through.
  const addPinnedRule = (text) => {
    const t = text?.trim();
    if (!t) return;
    setPinnedRules(prev => [...(prev || []), { id: `r_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, ts: new Date().toISOString(), text: t }].slice(-30));
  };
  const updatePinnedRule = (id, text) => {
    setPinnedRules(prev => (prev || []).map(r => r.id === id ? { ...r, text, ts: new Date().toISOString() } : r));
  };
  const deletePinnedRule = (id) => {
    setPinnedRules(prev => (prev || []).filter(r => r.id !== id));
  };
  const updateGlobalIntel = (idx, text) => {
    setGlobalIntel(prev => (prev || []).map((g, i) => i === idx ? { ...g, text } : g));
  };
  const deleteGlobalIntel = (idx) => {
    setGlobalIntel(prev => (prev || []).filter((_, i) => i !== idx));
  };
  const clearBuyerHistory = (id) => {
    if (!window.confirm('Clear this buyer\'s AI reasoning history? Notes and overrides are preserved. The next rescan will start with no prior reasoning context for this buyer.')) return;
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, aiHistory: [], aiNotes: null, aiCitations: [] } : b));
  };

  // winnerData is still used for the bottom "no deal · process fails to clear"
  // line and for the headline P(any deal closes) shown on Hero KPIs. Per-row
  // numbers are now the AI's standalone P(close with THIS group), not winner-
  // allocated — that's the question the user actually asks at row scope.
  const winnerData = winnerProbabilities(buyers, ebitda, caseMode);

  const ordered = [...buyers].sort((a, b) => {
    if (a.stage === 'dropped' && b.stage !== 'dropped') return 1;
    if (b.stage === 'dropped' && a.stage !== 'dropped') return -1;
    return (b.probability || 0) - (a.probability || 0);
  });

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">Prediction <span className="accent">Engine</span></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <BrainButton onClick={() => setShowBrain(true)} />
          <AIHistoryButton onClick={() => setShowHistory(true)} syncStatus={syncStatus} />
          <LibraryButton count={docs.length} onClick={() => setShowLibrary(true)} />
          <SystemBar
            ebitda={ebitda} onEbitda={setEbitda}
            caseMode={caseMode} onCase={setCaseMode}
            market={market} marketMeta={marketMeta} onRescan={rescanAll}
            rescanError={rescanError}
            clearingRationale={rationales?.clearing_price}
            lastRescanTs={rationales?.ts}
          />
        </div>
      </div>

      <HeroKPIs buyers={buyers} process={process} ebitda={ebitda} caseMode={caseMode} market={market} rationales={rationales} />

      <ProcessTracker process={process} onUpdate={setProcess} buyers={buyers} ebitda={ebitda} caseMode={caseMode} />

      <div className="pipeline">
        <Conversation
          buyers={buyers}
          pinnedRules={pinnedRules}
          globalIntel={globalIntel}
          market={market}
          rationales={rationales}
          ebitda={ebitda}
          onAddBuyerNote={routeIntelToBuyer}
          onAppendGlobal={appendGlobalIntel}
          onSetStage={setBuyerStage}
          onOverrideProbability={overrideBuyerProbability}
          onInvalidatePriors={invalidateBuyerPriors}
          onInvalidatePipelinePriors={invalidatePipelinePriors}
          onCorrectWebsite={correctBuyerWebsite}
          onRescanAll={rescanAll}
        />
        <div className="pipeline-head">
          <div className="pipeline-sub">{buyers.length} firms · ranked by win probability · type intel above to update predictions</div>
        </div>
        <div className="rows">
          {ordered.map((b, i) => (
            <BuyerRow
              key={b.id}
              buyer={b}
              displayRank={i + 1}
              selected={b.id === openId}
              onSelect={() => openBuyer(b.id)}
              onAppendNote={appendBuyerNote}
              onRescanBuyer={rescanOne}
              rescanning={!!rescanning[b.id]}
            />
          ))}
          <div className="row row-nodeal">
            <div className="row-nodeal-name">No deal · process fails to clear</div>
            <div className="row-nodeal-num">{winnerData.noDealPct}%</div>
          </div>
        </div>
      </div>

      <div className="footer">
        <div>Kennion Holdings · Benefits Program Sale</div>
        <div>Reagan Consulting · Spring 2026 process</div>
        <div>Engine v0.5 · learns as we go</div>
      </div>

      {open && (
        <BuyerModal
          buyer={open}
          onClose={() => { setOpenId(null); setOpenIntent(null); }}
          onAdvance={advance}
          onDrop={drop}
          onDelete={deleteBuyer}
          onAppendNote={appendBuyerNote}
          onRemoveNote={removeBuyerNote}
          onLogEvent={(id, key) => {
            const nid = logBuyerEvent(id, key);
            return rescanOne(id, { triggerNoteId: nid });
          }}
          onRescanBuyer={rescanOne}
          winnerPct={open.probability || 0}
        />
      )}

      {showLibrary && (
        <LibraryModal
          docs={docs}
          setDocs={setDocs}
          buyers={buyers}
          onClose={() => setShowLibrary(false)}
          onRescanBuyers={rescanMany}
        />
      )}

      {showHistory && (
        <AIHistoryModal onClose={() => setShowHistory(false)} buyers={buyers} />
      )}

      {showBrain && (
        <BrainModal
          onClose={() => setShowBrain(false)}
          buyers={buyers}
          ebitda={ebitda}
          caseMode={caseMode}
          market={market}
          process={process}
          docs={docs}
          pinnedRules={pinnedRules}
          globalIntel={globalIntel}
          onAddPinnedRule={addPinnedRule}
          onUpdatePinnedRule={updatePinnedRule}
          onDeletePinnedRule={deletePinnedRule}
          onUpdateGlobalIntel={updateGlobalIntel}
          onDeleteGlobalIntel={deleteGlobalIntel}
          onRemoveBuyerNote={removeBuyerNote}
          onClearBuyerHistory={clearBuyerHistory}
          onOpenBuyer={(id) => { setShowBrain(false); openBuyer(id); }}
          onOpenLibrary={() => { setShowBrain(false); setShowLibrary(true); }}
          onRescanAll={rescanAll}
        />
      )}

    </div>
  );
}
