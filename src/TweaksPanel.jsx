import { useState, useRef, useEffect, useCallback } from 'react';

const __TWEAKS_STYLE = `
  .twk-panel{position:fixed;right:16px;bottom:72px;z-index:2147483646;width:280px;
    max-height:calc(100vh - 32px);display:flex;flex-direction:column;
    background:rgba(250,249,247,.78);color:#29261b;
    -webkit-backdrop-filter:blur(24px) saturate(160%);backdrop-filter:blur(24px) saturate(160%);
    border:.5px solid rgba(255,255,255,.6);border-radius:14px;
    box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 12px 40px rgba(0,0,0,.18);
    font:11.5px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;overflow:hidden}
  .twk-hd{display:flex;align-items:center;justify-content:space-between;
    padding:10px 8px 10px 14px;cursor:move;user-select:none}
  .twk-hd b{font-size:12px;font-weight:600;letter-spacing:.01em}
  .twk-x{appearance:none;border:0;background:transparent;color:rgba(41,38,27,.55);
    width:22px;height:22px;border-radius:6px;cursor:default;font-size:13px;line-height:1}
  .twk-x:hover{background:rgba(0,0,0,.06);color:#29261b}
  .twk-body{padding:2px 14px 14px;display:flex;flex-direction:column;gap:10px;
    overflow-y:auto;overflow-x:hidden;min-height:0;
    scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.15) transparent}
  .twk-row{display:flex;flex-direction:column;gap:5px}
  .twk-row-h{flex-direction:row;align-items:center;justify-content:space-between;gap:10px}
  .twk-lbl{display:flex;justify-content:space-between;align-items:baseline;
    color:rgba(41,38,27,.72)}
  .twk-lbl>span:first-child{font-weight:500}
  .twk-sect{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
    color:rgba(41,38,27,.45);padding:10px 0 0}
  .twk-sect:first-child{padding-top:0}
  .twk-toggle{position:relative;width:32px;height:18px;border:0;border-radius:999px;
    background:rgba(0,0,0,.15);transition:background .15s;cursor:default;padding:0}
  .twk-toggle[data-on="1"]{background:#34c759}
  .twk-toggle i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;
    background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}
  .twk-toggle[data-on="1"] i{transform:translateX(14px)}
  .twk-row-action{align-items:stretch}
  .twk-action-btn{appearance:none;border:1px solid rgba(0,0,0,.18);background:transparent;
    color:#29261b;padding:7px 10px;border-radius:6px;font:inherit;font-weight:500;
    cursor:pointer;text-align:center;transition:background .12s,border-color .12s,color .12s}
  .twk-action-btn:hover{background:rgba(0,0,0,.06)}
  .twk-action-danger{border-color:rgba(196,68,68,.45);color:#a83232}
  .twk-action-danger:hover{background:rgba(196,68,68,.08);border-color:rgba(196,68,68,.7)}
  .twk-action-hint{font-size:10.5px;line-height:1.4;color:rgba(41,38,27,.55)}
  .twk-trigger{position:fixed;bottom:28px;left:28px;z-index:2147483646;
    width:36px;height:36px;border-radius:50%;border:1px solid rgba(0,0,0,.12);
    background:rgba(250,249,247,.9);backdrop-filter:blur(8px);
    cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;
    box-shadow:0 2px 8px rgba(0,0,0,.12);color:#29261b;transition:all .15s}
  .twk-trigger:hover{background:#29261b;color:#fff;border-color:#29261b}
`;

export function useTweaks(defaults) {
  const [values, setValues] = useState(defaults);
  const setTweak = useCallback((keyOrEdits, val) => {
    const edits = typeof keyOrEdits === 'object' && keyOrEdits !== null
      ? keyOrEdits : { [keyOrEdits]: val };
    setValues(prev => ({ ...prev, ...edits }));
  }, []);
  return [values, setTweak];
}

export function TweaksPanel({ title = 'Tweaks', children }) {
  const [open, setOpen] = useState(false);
  const dragRef = useRef(null);
  const offsetRef = useRef({ x: 16, y: 72 });
  const PAD = 16;

  const clampToViewport = useCallback(() => {
    const panel = dragRef.current;
    if (!panel) return;
    const w = panel.offsetWidth, h = panel.offsetHeight;
    const maxRight = Math.max(PAD, window.innerWidth - w - PAD);
    const maxBottom = Math.max(PAD, window.innerHeight - h - PAD);
    offsetRef.current = {
      x: Math.min(maxRight, Math.max(PAD, offsetRef.current.x)),
      y: Math.min(maxBottom, Math.max(PAD, offsetRef.current.y)),
    };
    panel.style.right = offsetRef.current.x + 'px';
    panel.style.bottom = offsetRef.current.y + 'px';
  }, []);

  useEffect(() => {
    if (!open) return;
    clampToViewport();
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(clampToViewport)
      : null;
    if (ro) { ro.observe(document.documentElement); return () => ro.disconnect(); }
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, [open, clampToViewport]);

  const onDragStart = (e) => {
    const panel = dragRef.current;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    const startRight = window.innerWidth - r.right;
    const startBottom = window.innerHeight - r.bottom;
    const move = (ev) => {
      offsetRef.current = {
        x: startRight - (ev.clientX - sx),
        y: startBottom - (ev.clientY - sy),
      };
      clampToViewport();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <>
      <style>{__TWEAKS_STYLE}</style>
      {!open && (
        <button className="twk-trigger" onClick={() => setOpen(true)} title="Tweaks">⚙</button>
      )}
      {open && (
        <div ref={dragRef} className="twk-panel"
             style={{ right: offsetRef.current.x, bottom: offsetRef.current.y }}>
          <div className="twk-hd" onMouseDown={onDragStart}>
            <b>{title}</b>
            <button className="twk-x" onMouseDown={e => e.stopPropagation()} onClick={() => setOpen(false)}>✕</button>
          </div>
          <div className="twk-body">{children}</div>
        </div>
      )}
    </>
  );
}

export function TweakSection({ label, children }) {
  return (
    <>
      <div className="twk-sect">{label}</div>
      {children}
    </>
  );
}

export function TweakToggle({ label, value, onChange }) {
  return (
    <div className="twk-row twk-row-h">
      <div className="twk-lbl"><span>{label}</span></div>
      <button type="button" className="twk-toggle" data-on={value ? '1' : '0'}
              role="switch" aria-checked={!!value}
              onClick={() => onChange(!value)}><i /></button>
    </div>
  );
}

export function TweakAction({ label, hint, onClick, danger = false }) {
  return (
    <div className="twk-row twk-row-action">
      <button type="button" className={"twk-action-btn" + (danger ? " twk-action-danger" : "")} onClick={onClick}>
        {label}
      </button>
      {hint && <div className="twk-action-hint">{hint}</div>}
    </div>
  );
}

export function TweakNumber({ label, value, onChange, hint, step = 1, min, max }) {
  const display = value == null || value === '' ? '' : String(value);
  return (
    <div className="twk-row">
      <div className="twk-lbl"><span>{label}</span></div>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={display}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '') return onChange(null);
          const n = parseFloat(v);
          if (!Number.isNaN(n)) onChange(n);
        }}
        style={{
          width: '100%',
          padding: '6px 8px',
          border: '1px solid rgba(0,0,0,.18)',
          borderRadius: 6,
          background: 'rgba(255,255,255,.55)',
          color: '#29261b',
          font: 'inherit',
          fontVariantNumeric: 'tabular-nums',
        }}
      />
      {hint && <div className="twk-action-hint">{hint}</div>}
    </div>
  );
}
