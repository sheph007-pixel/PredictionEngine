import { useState, useEffect, useRef } from 'react';
import { STAGES, STAGE_INDEX, PROCESS_DEFAULT, BUYERS } from './data.js';
import {
  HeroKPIs, ProcessTracker, SystemBar, BuyerRow, BuyerModal,
  Conversation, winnerProbabilities, AIHistoryButton, AIHistoryModal,
  BrainButton, BrainModal, PrintButton, STAGE_PROB_RANGE,
} from './components.jsx';
import { LibraryButton, LibraryModal, useLibrary } from './Library.jsx';
import { rescanPipeline, rescanBuyer, rescanBuyers, applyRescanToBuyers, fmtMetaFromRescan } from './lib/ai-engine.js';
import { fetchWorkspace, pushWorkspace, pushBuyers, patchBuyer, deleteBuyer, deleteNote, debouncedPush } from './lib/sync.js';
import { migrateNoteLog, appendNote, removeNote, latestNoteId, EVENT_SPECS, relativeTime } from './lib/notes.js';

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

// Optimistic stage-floor: when a buyer advances, lift their probability into
// the new stage's discipline range immediately so the UI reflects the move
// before the AI rescan refines the number. Never lowers an already-high prob.
function applyStageFloor(buyer, stage) {
  const range = STAGE_PROB_RANGE[stage];
  if (!range) return buyer;
  const cur = typeof buyer.probability === 'number' ? buyer.probability : 0;
  if (cur >= range.low) return buyer;
  return { ...buyer, probability: range.low };
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
  const [rationales, setRationales] = usePersistedState('rationales', { close_date: null, confidence: null, clearing_price: null, p_no_deal: null, p_no_deal_rationale: null, offer_date: null, offer_estimate: null, verdict: null });
  const [globalIntel, setGlobalIntel] = usePersistedState('globalIntel', []);
  const [pinnedRules, setPinnedRules] = usePersistedState('pinnedRules', []);

  const [openId, setOpenId] = useState(null);
  const [showDropped, setShowDropped] = useState(false);
  const [openIntent, setOpenIntent] = useState(null);
  const [showLibrary, setShowLibrary] = useState(false);

  // Deploy / prompt-version badge, fetched once at mount. Lets the user
  // confirm whether the latest merge is actually running on Railway. If
  // /api/health is down or returns non-JSON, the footer just doesn't render.
  const [build, setBuild] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then(r => r.ok ? r.json() : null)
      .then(b => { if (!cancelled) setBuild(b); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [showBrain, setShowBrain] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [docs, setDocs] = useLibrary();
  const [rescanError, setRescanError] = useState(null);

  // Mobile detection — drives the chat-as-FAB/modal rendering. Re-evaluates
  // when the viewport crosses the 600px breakpoint (e.g., browser resize on
  // desktop) so the right shape renders at the right size.
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 600px)');
    const onChange = (e) => setIsNarrow(e.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // When the user is running as an iOS home-screen webapp (PWA mode) and
  // returns to the app from background, do a hard reload so they see the
  // latest server state. Gated to PWA mode + >30s away so desktop users
  // tabbing away don't get reloaded every time they switch tabs.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isPWA = window.navigator.standalone === true
      || window.matchMedia('(display-mode: standalone)').matches;
    if (!isPWA) return;
    let leftAt = null;
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        leftAt = Date.now();
      } else if (document.visibilityState === 'visible' && leftAt && Date.now() - leftAt > 30_000) {
        window.location.reload();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const [syncStatus, setSyncStatus] = useState('local'); // 'local' | 'syncing' | 'synced' | 'offline'
  const hydrated = useRef(false);
  // Mirror of `buyers` that's always up-to-date synchronously. Rescan calls
  // fire right after `setBuyers` (e.g. stage-change triggers a rescan), and
  // `buyers` from the closure is one render behind — so the AI would see the
  // OLD stage and hit the "echo prior probability" rule. Reading from the ref
  // ensures the request body reflects the just-applied state.
  const buyersRef = useRef(buyers);
  useEffect(() => { buyersRef.current = buyers; }, [buyers]);

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
        // Race guard: if the user ran a rescan moments before refresh, the
        // debounced workspace push (~1s) may not have hit the server yet,
        // so ws.rationales would be the stale snapshot. captureRationales
        // stamps every rationale update with `ts`; only let the server win
        // when its ts is at-or-newer than the local one we hydrated from
        // localStorage. Without this, model-vote chips for the most recent
        // rescan blink away after a fast refresh.
        //
        // The same guard covers `market`: every rescan writes market and
        // rationales together (setMarket + captureRationales → one debounced
        // push), so a server snapshot older than the local rationales ts also
        // carries a stale market band. Accepting it re-imposed long-dead
        // bands (the $22M / 5.3–6.9× regression) which the write-through
        // effect then pushed back to Postgres, making the stale band sticky.
        const localTs = rationales?.ts ? new Date(rationales.ts).getTime() : 0;
        const serverTs = ws.rationales?.ts ? new Date(ws.rationales.ts).getTime() : 0;
        const serverFresh = serverTs >= localTs;
        if (ws.market && serverFresh) setMarket(ws.market);
        if (ws.market_meta && serverFresh) setMarketMeta(ws.market_meta);
        if (ws.rationales && serverFresh) setRationales(ws.rationales);
        if (ws.process) setProcess(ws.process);
        if (Array.isArray(ws.global_intel)) setGlobalIntel(ws.global_intel);
        if (Array.isArray(ws.pinned_rules)) setPinnedRules(ws.pinned_rules);
      }
      if (Array.isArray(result.buyers) && result.buyers.length > 0) {
        // Server-side runStartupMigrations (server.js) handles all structural
        // data corrections — demoScrub, CIM backfill, PE curation, seed notes,
        // Top 100 ranks. The client just trusts what comes from /api/workspace.
        // History: prior versions ran these as localStorage-gated client
        // migrations that re-fired in every fresh browser and pushed the full
        // buyer array back to Postgres, which clobbered any state the booting
        // browser hadn't seen yet (chat-added notes, deletions, drops). Moved
        // to the server in PR #17; client side is now a pure consumer.
        setBuyers(result.buyers);
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

  // Re-fetch workspace when the tab regains focus. Catches the case where a
  // background server-side migration ran (or another browser made changes)
  // while this tab was idle. Without this, a stale local state could persist
  // until the user manually reloads and the next PATCH from this tab would
  // try to write the stale state back (now protected by server-side stale
  // detection, but a fresh fetch closes the loop on the UI too).
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible' || !hydrated.current) return;
      // Skip refetch if the user has unsynced local changes (would clobber
      // them). lastSyncedBuyersRef tracks the last successfully-pushed state;
      // if it equals the current buyers state by reference, nothing is in
      // flight and a refetch is safe.
      if (lastSyncedBuyersRef.current !== buyersRef.current) return;
      const result = await fetchWorkspace();
      if (!result.available) return;
      if (Array.isArray(result.buyers) && result.buyers.length > 0) {
        setBuyers(result.buyers);
        lastSyncedBuyersRef.current = result.buyers;
      }
      if (result.workspace) {
        const ws = result.workspace;
        if (ws.process) setProcess(ws.process);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
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

  // Buyers sync — per-buyer PATCH for changed rows, DELETE for removed rows.
  // Replaces the prior bulk-replace pattern (PUT /api/buyers) which let a
  // stale browser clobber rows it had never seen. Diff is computed against
  // the last successfully-written snapshot; first post-hydration tick just
  // captures the baseline without writing anything.
  const lastSyncedBuyersRef = useRef(null);
  useEffect(() => {
    if (!hydrated.current) return;
    if (lastSyncedBuyersRef.current === null) {
      lastSyncedBuyersRef.current = buyers;
      return;
    }
    setSyncStatus('syncing');
    debouncedPush('buyers', async () => {
      const prev = lastSyncedBuyersRef.current || [];
      const prevById = new Map(prev.map(b => [b.id, b]));
      const currentById = new Map(buyers.map(b => [b.id, b]));
      const toPatch = [];
      for (const b of buyers) {
        const old = prevById.get(b.id);
        if (!old || JSON.stringify(old) !== JSON.stringify(b)) toPatch.push(b);
      }
      const toDelete = [];
      for (const old of prev) {
        if (!currentById.has(old.id)) toDelete.push(old.id);
      }
      const results = await Promise.all([
        ...toPatch.map(b => patchBuyer(b)),
        ...toDelete.map(id => deleteBuyer(id)),
      ]);
      const allOk = results.length === 0 || results.every(r => r);
      if (allOk) lastSyncedBuyersRef.current = buyers;
      setSyncStatus(allOk ? 'synced' : 'offline');
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
      offer_date: result.offer_date_rationale ?? prev.offer_date ?? null,
      offer_estimate: result.offer_estimate ?? prev.offer_estimate ?? null,
      verdict: (typeof result.verdict === 'string' && result.verdict.trim()) ? result.verdict.trim() : (prev.verdict ?? null),
      two_model: !!result.two_model,
      models: result.models || prev.models || null,
      ts: result.ts || new Date().toISOString(),
    }));
  };

  // Stamp every attempt (success or fail) so the SystemBar label can surface
  // a stale-data warning if the user clicked Update today but the rescan
  // threw. Without this the label shows the last *successful* time only,
  // which can read 'yesterday' even though the user just tried to refresh.
  const stampAttempt = () => {
    const now = new Date().toISOString();
    setRationales(prev => ({ ...prev, lastAttemptTs: now }));
  };

  const rescanAll = async (extraIntel = null) => {
    setRescanError(null);
    stampAttempt();
    try {
      const result = await rescanPipeline({
        buyers: buyersRef.current,
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

  // Per-buyer rescan trigger — used by note submission, stage changes, and
  // per-buyer "rescan" buttons. With a small pipeline (7 live buyers) we
  // always re-score the WHOLE field so ranks stay internally consistent.
  // Re-scoring a single buyer in isolation lets their fresh probability
  // sort against stale peers, which produces visibly wrong rankings.
  //
  // opts.triggerNoteId — when triggered by a fresh note append, pass the new
  // note's id so applyRescanToBuyers tags the buyer's aiHistory entry. Lets
  // the timeline UI show "AI re-scored after this note".
  const rescanOne = async (buyerId, opts = {}) => {
    setRescanError(null);
    stampAttempt();
    try {
      const result = await rescanPipeline({
        buyers: buyersRef.current,
        ebitda,
        fileIds,
        priorMarket: market,
        globalIntel,
        extraIntel: opts.extraIntel || null,
        pinnedRules,
      });
      const trigger = opts.triggerNoteId
        ? { buyerId, noteId: opts.triggerNoteId }
        : null;
      setBuyers(bs => applyRescanToBuyers(bs, result, { trigger }));
      setMarket(result.market);
      setMarketMeta(fmtMetaFromRescan(result, result.buyers.length));
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
        buyers: buyersRef.current,
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

  const triggerRescanForStageChange = async (id, fromStage, toStage) => {
    setRescanning(r => ({ ...r, [id]: true }));
    const target = buyersRef.current.find(b => b.id === id);
    const name = target?.name || id;
    const extraIntel = fromStage && toStage
      ? `STAGE CHANGE: ${name} moved from ${fromStage} → ${toStage}. This is new evidence — re-evaluate probability per stage discipline range (do not echo prior).`
      : null;
    try {
      await rescanOne(id, { extraIntel });
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
    const prev = buyersRef.current.find(b => b.id === id);
    const prevStage = prev?.stage;
    const idx = STAGE_INDEX[prevStage];
    const nextStage = STAGES[Math.min(idx + 1, STAGES.length - 1)].id;
    setBuyers(bs => bs.map(b => b.id === id ? applyStageFloor({ ...b, stage: nextStage }, nextStage) : b));
    triggerRescanForStageChange(id, prevStage, nextStage);
  };
  const drop = (id) => {
    const prev = buyersRef.current.find(b => b.id === id);
    const prevStage = prev?.stage;
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, stage: 'dropped' } : b));
    triggerRescanForStageChange(id, prevStage, 'dropped');
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
  // The buyers-sync useEffect would otherwise PATCH the buyer with the
  // shorter noteLog, but the server PATCH union-merges noteLog and would
  // preserve the deleted note. Explicit DELETE propagates the deletion.
  const removeBuyerNote = (id, noteId) => {
    setBuyers(bs => bs.map(b => b.id === id ? removeNote(migrateNoteLog(b), noteId) : b));
    deleteNote(id, noteId).catch(() => {});
  };

  // Stamp a structured stage event on a buyer in one atomic state update:
  // append the canonical note, set the structural field (nda_signed,
  // chemistry_date), and advance the stage if the target is later than
  // current (`force` overrides for terminal events like declined → dropped).
  // Returns the new note id so the caller can tag the rescan that follows.
  const logBuyerEvent = (id, eventKey, dateOverride = null) => {
    const spec = EVENT_SPECS[eventKey];
    if (!spec) return null;
    // dateOverride (YYYY-MM-DD) carries a user-stated event date — back-dated
    // corrections ("CIM received 5/28") or scheduled future events. Without
    // it, '$today' stamps the day the user happened to log the event.
    const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateOverride || ''))
      ? dateOverride
      : new Date().toISOString().slice(0, 10);
    let newNoteId = null;
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      const noteText = dateOverride ? `${spec.text} (${eventDate})` : spec.text;
      let next = appendNote(migrateNoteLog(b), noteText);
      newNoteId = latestNoteId(next.noteLog);
      if (spec.field) {
        next = { ...next, [spec.field]: spec.value === '$today' ? eventDate : spec.value };
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
  // Batch event stamping for the Conversation chat tool — fans a single event
  // across N buyers in one call. Per-buyer mutation reuses logBuyerEvent;
  // optional reason gets appended as a follow-up note for audit attribution;
  // ONE consolidated rescan fires for the affected slice (not N rescans, so
  // the memoization layer + AI both see the batch as a single state change).
  const logBatchEvent = (buyerIds, eventKey, reason, date = null) => {
    if (!Array.isArray(buyerIds) || buyerIds.length === 0) return;
    const spec = EVENT_SPECS[eventKey];
    if (!spec) return;
    const applied = [];
    for (const id of buyerIds) {
      const nid = logBuyerEvent(id, eventKey, date);
      if (nid) applied.push(id);
    }
    if (applied.length === 0) return;
    if (reason && reason.trim()) {
      for (const id of applied) appendBuyerNote(id, `Source: ${reason.trim()}`);
    }
    // Fire-and-forget — UI shows per-row "AI re-scoring…" while it runs.
    rescanMany(applied).catch(() => {});
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
    const prev = buyersRef.current.find(b => b.id === id);
    const from = prev?.stage ?? null;
    setBuyers(bs => bs.map(b => b.id === id ? applyStageFloor({ ...b, stage }, stage) : b));
    if (reason) recordOverride(id, { kind: 'stage', from, to: stage, reason });
    if (from !== stage) triggerRescanForStageChange(id, from, stage);
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
      offer_date: null,
      offer_estimate: null,
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
  // Pass the AI's p_no_deal so the row's no-deal % matches the KPI's
  // deal-confidence %. Without it the row computes a slightly different
  // number from the independent-union formula.
  const winnerData = winnerProbabilities(buyers, ebitda, caseMode, rationales?.p_no_deal);

  // Sort by the same winner-allocated share displayed on each row. Sorting
  // by raw buyer.probability disagrees with the displayed share when integer
  // rounding inverts the order (e.g., Oakbridge raw 31 / share 20 ranks
  // ABOVE Trucordia raw 32 / share 19 by share, but raw sort flips them).
  // Falls back to raw probability when shares tie, then to name.
  const shareOf = (b) => winnerData.winnerByBuyer[b.id] ?? 0;
  const ordered = [...buyers].sort((a, b) => {
    if (a.stage === 'dropped' && b.stage !== 'dropped') return 1;
    if (b.stage === 'dropped' && a.stage !== 'dropped') return -1;
    const ds = shareOf(b) - shareOf(a);
    if (ds !== 0) return ds;
    const dp = (b.probability || 0) - (a.probability || 0);
    if (dp !== 0) return dp;
    return (a.name || '').localeCompare(b.name || '');
  });
  const orderedLive = ordered.filter(b => b.stage !== 'dropped');
  const orderedDropped = ordered.filter(b => b.stage === 'dropped');

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">Prediction <span className="accent">Engine</span></div>
        </div>
        <div className="topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* topbar-buttons wraps the four mobile-hidden buttons so the
              SystemBar (Update + EBITDA) stays visible on mobile next to
              the brand mark. */}
          <div className="topbar-buttons" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <PrintButton />
            <BrainButton onClick={() => setShowBrain(true)} />
            <AIHistoryButton onClick={() => setShowHistory(true)} syncStatus={syncStatus} />
            <LibraryButton count={docs.length} onClick={() => setShowLibrary(true)} />
          </div>
          <SystemBar
            ebitda={ebitda} onEbitda={setEbitda}
            caseMode={caseMode} onCase={setCaseMode}
            market={market} marketMeta={marketMeta} onRescan={rescanAll}
            rescanError={rescanError}
            clearingRationale={rationales?.clearing_price}
            lastRescanTs={rationales?.ts}
            lastAttemptTs={rationales?.lastAttemptTs}
          />
        </div>
      </div>

      <div className="print-header">
        <div className="print-header-title">Kennion Benefits Program · Buyer Pipeline</div>
        <div className="print-header-meta">Reagan Consulting · {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</div>
      </div>

      <HeroKPIs buyers={buyers} process={process} ebitda={ebitda} caseMode={caseMode} market={market} rationales={rationales} />

      <ProcessTracker process={process} onUpdate={setProcess} buyers={buyers} ebitda={ebitda} caseMode={caseMode} />

      {/* Advisor chat is its own card, visually separate from the ranked
          list below. Desktop only — on mobile it renders inside a slide-up
          modal triggered by the floating chat button so the dashboard stays
          a clean read-only surface. Same model as the engine (best available
          via the server's fallback chain), same tools, same messages
          (localStorage). */}
      {!isNarrow && (
        <div className="advisor-card">
          <div className="advisor-card-head">
            <span className="advisor-dot" />
            <b>Deal advisor</b>
            <span className="advisor-card-hint">log intel · correct anything · ask questions — predictions update automatically</span>
          </div>
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
            onLogBatchEvent={logBatchEvent}
            onRescanAll={rescanAll}
          />
        </div>
      )}

      <div className="pipeline">
        <div className="rows">
          {orderedLive.map((b, i) => (
            <BuyerRow
              key={b.id}
              buyer={b}
              displayRank={i + 1}
              selected={b.id === openId}
              winShare={winnerData.winnerByBuyer[b.id]}
              onSelect={() => openBuyer(b.id)}
              onAppendNote={appendBuyerNote}
              onRescanBuyer={rescanOne}
              rescanning={!!rescanning[b.id]}
            />
          ))}
          {orderedDropped.length > 0 && (
            <button
              type="button"
              className="dropped-toggle"
              onClick={() => setShowDropped(s => !s)}
              title={showDropped ? 'Hide dropped buyers' : 'Show dropped buyers'}
            >
              {showDropped ? '▾' : '▸'} {orderedDropped.length} dropped
            </button>
          )}
          {showDropped && orderedDropped.map((b) => (
            <BuyerRow
              key={b.id}
              buyer={b}
              displayRank={'-'}
              selected={b.id === openId}
              winShare={0}
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
          winnerPct={winnerData.winnerByBuyer[open.id] ?? 0}
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

      {build && (
        <div className="build-footer" title={build.commit_message || ''}>
          <span className="build-sha">build {build.version}</span>
          {' · '}
          <span className="build-prompt">prompt v{build.prompt_version}</span>
          {build.model && (
            <>
              {' · '}
              <span className="build-model">{build.model}</span>
            </>
          )}
          {build.started_at && (
            <>
              {' · '}
              <span className="build-started" title={build.started_at}>
                deployed {relativeTime(build.started_at)}
              </span>
            </>
          )}
          {build.branch && build.branch !== 'main' && (
            <span className="build-branch"> · branch {build.branch}</span>
          )}
        </div>
      )}

    </div>
  );
}
