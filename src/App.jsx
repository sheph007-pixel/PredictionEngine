import { useState, useEffect } from 'react';
import { STAGES, STAGE_INDEX, PROCESS_DEFAULT, BUYERS } from './data.js';
import {
  HeroKPIs, ProcessTracker, SystemBar, BuyerRow, BuyerModal,
  AddBuyerForm, AIChat, winnerProbabilities,
} from './components.jsx';
import { TweaksPanel, TweakSection, TweakToggle, useTweaks } from './TweaksPanel.jsx';

const TWEAK_DEFAULTS = { darkMode: false };

export default function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [buyers, setBuyers] = useState(BUYERS);
  const [process, setProcess] = useState(PROCESS_DEFAULT);
  const [openId, setOpenId] = useState(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [ebitda, setEbitda] = useState(18);
  const [caseMode, setCaseMode] = useState("mid");
  const [market, setMarket] = useState({
    conservative: { low: 8.5,  high: 10.5, label: "Conservative", note: "Bear case · soft market" },
    mid:          { low: 11.0, high: 13.0, label: "Realistic",     note: "Base case · current signals" },
    aggressive:   { low: 13.5, high: 15.5, label: "Aggressive",    note: "Bull case · strategic premium" },
  });
  const [marketMeta, setMarketMeta] = useState("AI · sector deal flow + public comp drift · 2 min ago");

  const refreshMarket = () => {
    const jitter = () => (Math.random() - 0.5) * 0.6;
    setMarket(m => ({
      conservative: { ...m.conservative, low: +(Math.max(7,  m.conservative.low  + jitter())).toFixed(1), high: +(Math.max(8,  m.conservative.high + jitter())).toFixed(1) },
      mid:          { ...m.mid,          low: +(Math.max(9,  m.mid.low           + jitter())).toFixed(1), high: +(Math.max(10, m.mid.high          + jitter())).toFixed(1) },
      aggressive:   { ...m.aggressive,   low: +(Math.max(12, m.aggressive.low    + jitter())).toFixed(1), high: +(Math.max(13, m.aggressive.high   + jitter())).toFixed(1) },
    }));
    const newCount = 12 + Math.floor(Math.random() * 3);
    setMarketMeta(`AI · scanned ${newCount} fresh signals · just now`);
  };

  useEffect(() => {
    document.body.classList.toggle("dark", !!tweaks.darkMode);
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
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, stage: "dropped" } : b));
  };
  const adjustMultiple = (id, delta) => {
    setBuyers(bs => bs.map(b => b.id === id ? { ...b, multipleAdj: (b.multipleAdj || 0) + delta } : b));
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
    if (!window.confirm("Permanently delete this buyer from the pipeline? This cannot be undone.")) return;
    setBuyers(bs => bs.filter(b => b.id !== id));
    setOpenId(null);
  };

  const winnerData = winnerProbabilities(buyers, ebitda, caseMode);
  const ordered = [...buyers].sort((a, b) => {
    if (a.stage === "dropped" && b.stage !== "dropped") return 1;
    if (b.stage === "dropped" && a.stage !== "dropped") return -1;
    return (winnerData.winnerByBuyer[b.id] || 0) - (winnerData.winnerByBuyer[a.id] || 0);
  });

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">Prediction <span className="accent">Engine</span></div>
          <div className="brand-tag">Kennion · Project Beacon · Confidential</div>
        </div>
        <SystemBar
          ebitda={ebitda} onEbitda={setEbitda}
          caseMode={caseMode} onCase={setCaseMode}
          market={market} marketMeta={marketMeta} onRescan={refreshMarket}
        />
      </div>

      <HeroKPIs buyers={buyers} process={process} ebitda={ebitda} caseMode={caseMode} market={market} />

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
          <div>AI DEAL VALUE</div>
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
              onSelect={() => setOpenId(b.id)}
              onAdvance={advance}
              onDrop={drop}
              ebitda={ebitda}
              caseMode={caseMode}
              market={market}
              winnerPct={winnerData.winnerByBuyer[b.id] || 0}
              winnerDeltaPct={b.lastWeekWinnerPct != null ? (winnerData.winnerByBuyer[b.id] || 0) - b.lastWeekWinnerPct : null}
            />
          ))}
          <div className="row row-nodeal">
            <div className="row-rank">—</div>
            <div className="row-name">
              <div className="row-name-main row-nodeal-name">No deal</div>
              <div className="row-name-meta row-nodeal-meta">Process fails to clear · we walk</div>
            </div>
            <div></div>
            <div className="row-deal"><div className="row-deal-out">— —</div></div>
            <div className="row-prob">
              <div className="prob-bar">
                <div className="prob-bar-fill prob-bar-nodeal" style={{ width: winnerData.noDealPct + "%" }}></div>
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
          onClose={() => setOpenId(null)}
          onAdvance={advance}
          onDrop={drop}
          onDelete={deleteBuyer}
          onUpdateNotes={updateNotes}
          onAdjustMultiple={adjustMultiple}
          ebitda={ebitda}
          caseMode={caseMode}
        />
      )}

      {showAdd && (
        <AddBuyerForm
          onAdd={addBuyer}
          onCancel={() => setShowAdd(false)}
          existingBuyers={buyers}
        />
      )}

      <AIChat buyers={buyers} open={aiOpen} onToggle={() => setAiOpen(!aiOpen)} />

      <TweaksPanel title="Tweaks">
        <TweakSection label="Display">
          <TweakToggle label="Dark mode" value={tweaks.darkMode} onChange={(v) => setTweak("darkMode", v)} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}
