import { useState, useEffect, useRef } from 'react';
import { uploadFiles, classifyFile, deleteFile } from './utils/ai.js';

const STORAGE_KEY = 'kennion.library.v1';

export function useLibrary() {
  const [docs, setDocs] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(docs)); } catch {}
  }, [docs]);

  return [docs, setDocs];
}

const DOC_TYPE_LABELS = {
  CIM: 'CIM',
  LOI: 'LOI',
  NDA: 'NDA',
  buyer_email: 'Email',
  financial_model: 'Model',
  market_analysis: 'Analysis',
  due_diligence: 'DD',
  redline: 'Redline',
  other: 'Doc',
};

export function LibraryModal({ docs, setDocs, buyers, onClose, onRescanBuyers }) {
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const [rescanStatus, setRescanStatus] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleFiles = async (files) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const { files: uploaded } = await uploadFiles(Array.from(files));
      // Add as pending, then classify in parallel
      const pending = uploaded.map(u => ({
        ...u,
        classification: null,
        classifying: true,
        uploadedAt: new Date().toISOString(),
      }));
      setDocs(d => [...pending, ...d]);

      const classifications = await Promise.all(uploaded.map(async (u) => {
        try {
          const cls = await classifyFile({ fileId: u.id, filename: u.filename, buyers });
          setDocs(d => d.map(doc => doc.id === u.id ? { ...doc, classification: cls, classifying: false } : doc));
          return cls;
        } catch (e) {
          setDocs(d => d.map(doc => doc.id === u.id ? { ...doc, classifying: false, classification: { doc_type: 'other', title: u.filename, summary: 'Classification failed.', associated_buyers: [], key_points: [] } } : doc));
          return null;
        }
      }));

      // Any buyers tagged in any uploaded doc → trigger AI rescore so the
      // new evidence flows into multiples / probability / fit / thesis.
      const tagged = new Set();
      classifications.forEach(c => (c?.associated_buyers || []).forEach(id => tagged.add(id)));
      const buyerIds = [...tagged].filter(id => buyers.some(b => b.id === id));
      if (buyerIds.length > 0 && onRescanBuyers) {
        setRescanStatus(`AI re-scoring ${buyerIds.length} buyer${buyerIds.length === 1 ? '' : 's'} from new evidence…`);
        try {
          await onRescanBuyers(buyerIds);
          setRescanStatus(`Re-scored ${buyerIds.length} buyer${buyerIds.length === 1 ? '' : 's'} from new docs.`);
        } catch (e) {
          setRescanStatus(`Re-score failed: ${e.message}`);
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this document from the library?')) return;
    try { await deleteFile(id); } catch {}
    setDocs(d => d.filter(doc => doc.id !== id));
  };

  const fmtSize = (b) => b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const buyerById = Object.fromEntries(buyers.map(b => [b.id, b]));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760 }}>
        <button className="modal-close" onClick={onClose}>×</button>
        <div className="modal-eyebrow">Document library</div>
        <div className="modal-title" style={{ fontSize: 30, marginBottom: 6 }}>Deal documents</div>
        <div className="modal-sub" style={{ marginBottom: 18 }}>Upload CIM, LOIs, buyer emails, redlines — anything. Claude reads each, classifies it, and keeps it in context for chat.</div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !uploading && fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--rule-2)'}`,
            background: dragOver ? 'var(--accent-soft)' : 'var(--bg)',
            borderRadius: 6,
            padding: '32px 20px',
            textAlign: 'center',
            cursor: uploading ? 'wait' : 'pointer',
            transition: 'all 0.15s',
            marginBottom: 18,
          }}
        >
          <div style={{ fontFamily: 'var(--serif)', fontSize: 18, color: 'var(--ink)', marginBottom: 4 }}>
            {uploading ? 'Uploading…' : 'Drop files here or click to browse'}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', letterSpacing: '0.04em' }}>
            PDF, DOCX, TXT · up to 32MB · multi-select supported
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.docx,.doc,application/pdf,text/plain,text/markdown"
          style={{ display: 'none' }}
          onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
        />

        {error && (
          <div className="add-error" style={{ marginBottom: 12 }}>{error}</div>
        )}

        {rescanStatus && (
          <div style={{
            marginBottom: 12,
            padding: '10px 14px',
            background: 'var(--accent-soft)',
            border: '1px solid var(--accent)',
            borderRadius: 4,
            fontFamily: 'var(--mono)',
            fontSize: 11,
            letterSpacing: '0.04em',
            color: 'var(--ink)',
          }}>
            {rescanStatus}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {docs.length === 0 && !uploading && (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--ink-3)', fontSize: 13 }}>
              No documents yet. Upload the CIM to start.
            </div>
          )}
          {docs.map(doc => {
            const cls = doc.classification;
            const associated = (cls?.associated_buyers || []).map(id => buyerById[id]?.name).filter(Boolean);
            return (
              <div key={doc.id} style={{
                border: '1px solid var(--rule)',
                borderRadius: 4,
                padding: '12px 14px',
                background: 'var(--bg-card)',
                display: 'flex',
                gap: 14,
                alignItems: 'flex-start',
              }}>
                <div style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 9.5,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  padding: '4px 6px',
                  borderRadius: 2,
                  minWidth: 56,
                  textAlign: 'center',
                  flexShrink: 0,
                }}>
                  {doc.classifying ? '...' : (DOC_TYPE_LABELS[cls?.doc_type] || 'Doc')}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 16, color: 'var(--ink)', marginBottom: 2 }}>
                    {cls?.title || doc.filename}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.04em', marginBottom: 6 }}>
                    {doc.filename} · {fmtSize(doc.size_bytes)}
                    {associated.length > 0 && <> · re: {associated.join(', ')}</>}
                  </div>
                  {doc.classifying && (
                    <div style={{ fontSize: 12, color: 'var(--ink-3)', fontStyle: 'italic' }}>Reading & classifying…</div>
                  )}
                  {cls?.summary && (
                    <div style={{ fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.5 }}>{cls.summary}</div>
                  )}
                  {cls?.key_points?.length > 0 && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontSize: 12, color: 'var(--ink-2)' }}>
                      {cls.key_points.map((p, i) => <li key={i} style={{ marginBottom: 2 }}>{p}</li>)}
                    </ul>
                  )}
                </div>
                <button
                  className="btn-mini btn-mini-drop"
                  onClick={() => remove(doc.id)}
                  style={{ flexShrink: 0 }}
                >Remove</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function LibraryButton({ count, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'transparent',
        border: '1px solid var(--rule-2)',
        borderRadius: 4,
        padding: '6px 12px',
        cursor: 'pointer',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--ink-2)',
        transition: 'all 0.12s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ink)'; e.currentTarget.style.color = 'var(--bg)'; e.currentTarget.style.borderColor = 'var(--ink)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--ink-2)'; e.currentTarget.style.borderColor = 'var(--rule-2)'; }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      Library {count > 0 && <span style={{ color: 'var(--accent)' }}>· {count}</span>}
    </button>
  );
}
