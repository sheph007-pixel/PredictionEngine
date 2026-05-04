import { useState, useEffect, useRef } from 'react';
import { STAGES, STAGE_INDEX, PROCESS_DEFAULT, BUYERS } from './data.js';
import {
  HeroKPIs, ProcessTracker, SystemBar, BuyerRow, BuyerModal,
  AddBuyerForm, AIChat, winnerProbabilities, AIHistoryButton, AIHistoryModal,
} from './components.jsx';
import { TweaksPanel, TweakSection, TweakToggle, useTweaks } from './TweaksPanel.jsx';
import { LibraryButton, LibraryModal, useLibrary } from './Library.jsx';
import { rescanPipeline, rescanBuyer, rescanBuyers, applyRescanToBuyers, fmtMetaFromRescan } from './lib/ai-engine.js';
import { fetchWorkspace, pushWorkspace, pushBuyers, debouncedPush } from './lib/sync.js';

const TWEAK_DEFAULTS = { darkMode: false };
const STATE_KEY = 'kennion.state.v1';

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
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [buyers, setBuyers] = usePersistedState('buyers', BUYERS);
  const [process, setProcess] = usePersistedState('process', PROCESS_DEFAULT);
  const [ebitda, setEbitda] = usePersistedState('ebitda', 18);
  const [caseMode, setCaseMode] = usePersistedState('caseMode', 'mid');
  const [market, setMarket] = usePersistedState('market', DEFAULT_MARKET);
  const [marketMeta, setMarketMeta] = usePersistedState('marketMeta', 'AI · sector deal flow + public comp drift · 2 min ago');
  const [rationales, setRationales] = usePersistedState('rationales', { close_date: null, confidence: null, clearing_price: null });

  const [openId, setOpenId] = useState(null);
  const [openIntent, setOpenIntent] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
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
        if (ws.process) setProcess(ws.process);
      }
      if (Array.isArray(result.buyers) && result.buyers.length > 0) {
        setBuyers(result.buyers);
      } else {
        // Server is empty — push our local state up as the seed.
        await pushBuyers(buyers);
        await pushWorkspace({
          ebitda, case_mode: caseMode, market, market_meta: marketMeta,
          rationales, process,
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
        rationales, process,
      });
      setSyncStatus(ok ? 'synced' : 'offline');
    });
  }, [ebitda, caseMode, market, marketMeta, rationales, process]);

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
    setRationales({
      close_date: result.close_date_rationale || null,
      confidence: result.confidence_rationale || null,
      clearing_price: result.clearing_price_rationale || null,
      ts: result.ts || new Date().toISOString(),
    });
  };

  const rescanAll = async () => {
    setRescanError(null);
    try {
      const result = await rescanPipeline({
        buyers,
        ebitda,
        fileIds,
        priorMarket: market,
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
  const rescanOne = async (buyerId) => {
    setRescanError(null);
    try {
      const result = await rescanBuyer({
        buyers,
        ebitda,
        fileIds,
        priorMarket: market,
        buyerId,
      });
      setBuyers(bs => applyRescanToBuyers(bs, result));
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

  useEffect(() => {
    document.body.classList.toggle('dark', !!tweaks.darkMode);
  }, [tweaks.darkMode]);

  const open = buyers.find(b => b.id === openId);

  const advance = (id) => {
    setBuyers(bs => bs.map(b => {
      if (b.id !== id) return b;
      const idx = STAGE_INDEX[b.stage];
      const next = STAGES[Math.min(idx + 1, STAGES.length - 1)];
      return { ...b, stage: next.id };
    }));
  };
  const drop = (id) => {
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, stage: 'dropped' } : b));
  };
  const updateNotes = (id, notes) => {
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, notes } : b));
  };
  const addBuyer = (newBuyer) => {
    setBuyers(bs => [...bs, newBuyer]);
    setShowAdd(false);
    setOpenId(newBuyer.id);
  };
  const deleteBuyer = (id) => {
    if (!window.confirm('Permanently delete this buyer from the pipeline? This cannot be undone.')) return;
    setBuyers(bs => bs.filter(b => b.id !== id));
    setOpenId(null);
  };
  const openBuyer = (id, intent = null) => { setOpenId(id); setOpenIntent(intent); };

  const winnerData = winnerProbabilities(buyers, ebitda, caseMode);
  const ordered = [...buyers].sort((a, b) => {
    if (a.stage === 'dropped' && b.stage !== 'dropped') return 1;
    if (b.stage === 'dropped' && a.stage !== 'dropped') return -1;
    return (winnerData.winnerByBuyer[b.id] || 0) - (winnerData.winnerByBuyer[a.id] || 0);
  });

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">Prediction <span className="accent">Engine</span></div>
          <div className="brand-tag">Kennion · Project Beacon · Confidential</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <AIHistoryButton onClick={() => setShowHistory(true)} syncStatus={syncStatus} />
          <LibraryButton count={docs.length} onClick={() => setShowLibrary(true)} />
          <SystemBar
            ebitda={ebitda} onEbitda={setEbitda}
            caseMode={caseMode} onCase={setCaseMode}
            market={market} marketMeta={marketMeta} onRescan={rescanAll}
            rescanError={rescanError}
          />
        </div>
      </div>

      <HeroKPIs buyers={buyers} process={process} ebitda={ebitda} caseMode={caseMode} market={market} rationales={rationales} />

      <ProcessTracker process={process} onUpdate={setProcess} buyers={buyers} ebitda={ebitda} caseMode={caseMode} />

      <div className="pipeline">
        <div className="pipeline-head">
          <div>
            <div className="pipeline-title">Buyer pipeline</div>
            <div className="pipeline-sub" style={{ marginTop: 4 }}>{buyers.length} firms · ranked by AI prediction of who closes</div>
          </div>
          <div className="pipeline-head-actions">
            <div className="pipeline-sub">Sorted: likelihood ↓</div>
            <button className="btn btn-add" onClick={() => setShowAdd(true)}>+ Add buyer</button>
          </div>
        </div>
        <div className="pipeline-legend">
          <div>RANK</div>
          <div>FIRM</div>
          <div>STAGE</div>
          <div>P(WINNER)</div>
          <div></div>
        </div>
        <div className="rows">
          {ordered.map((b, i) => (
            <BuyerRow
              key={b.id}
              buyer={b}
              displayRank={i + 1}
              selected={b.id === openId}
              onSelect={() => openBuyer(b.id)}
              onAdvance={advance}
              onDrop={drop}
              winnerPct={winnerData.winnerByBuyer[b.id] || 0}
            />
          ))}
          <div className="row row-nodeal">
            <div className="row-rank">—</div>
            <div className="row-name">
              <div className="row-name-main row-nodeal-name">No deal</div>
              <div className="row-name-meta row-nodeal-meta">Process fails to clear · we walk</div>
            </div>
            <div></div>
            <div className="row-prob">
              <div className="prob-bar">
                <div className="prob-bar-fill prob-bar-nodeal" style={{ width: winnerData.noDealPct + '%' }}></div>
              </div>
              <div className="prob-num row-nodeal-num">{winnerData.noDealPct}<span>%</span></div>
            </div>
            <div></div>
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
          onUpdateNotes={updateNotes}
          onRescanBuyer={rescanOne}
          winnerPct={winnerData.winnerByBuyer[open.id] || 0}
        />
      )}

      {showAdd && (
        <AddBuyerForm
          onAdd={addBuyer}
          onCancel={() => setShowAdd(false)}
          existingBuyers={buyers}
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

      <AIChat
        buyers={buyers}
        setBuyers={setBuyers}
        fileIds={docs.map(d => d.id)}
        open={aiOpen}
        onToggle={() => setAiOpen(!aiOpen)}
      />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Display">
          <TweakToggle label="Dark mode" value={tweaks.darkMode} onChange={(v) => setTweak('darkMode', v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}
