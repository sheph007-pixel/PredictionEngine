// Per-buyer notes timeline. Single source of truth for migrate/append/format.
//
// Notes were historically a single editable string on each buyer. Users were
// already manually prefixing entries with [YYYY-MM-DD] markers. We now treat
// notes as an append-only chronological log so the AI can track momentum
// (warming, cooling, stalling) rather than just average sentiment, and so
// every field-intel update can trigger a per-buyer rescan.
//
// Schema:
//   buyer.noteLog: NoteEntry[]
//   NoteEntry = { id: string, ts: ISO string, text: string }
//
// Backward compat: legacy `buyer.notes: string` is migrated lazily on load.
// `[YYYY-MM-DD] text` markers in the legacy string are parsed into separate
// dated entries so the user's existing chronology is preserved.

const DATE_MARKER = /\[(\d{4}-\d{2}-\d{2})\]\s*/g;

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'n_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Parse a legacy notes string into NoteEntry[]. Splits on [YYYY-MM-DD] markers
// and dates each chunk by its leading marker. Any text BEFORE the first marker
// becomes a single entry dated by `fallbackTs`.
function parseLegacyNotes(notes, fallbackTs) {
  if (!notes || typeof notes !== 'string') return [];
  const trimmed = notes.trim();
  if (!trimmed) return [];

  const matches = [];
  let m;
  DATE_MARKER.lastIndex = 0;
  while ((m = DATE_MARKER.exec(trimmed)) !== null) {
    matches.push({ index: m.index, end: m.index + m[0].length, date: m[1] });
  }

  if (matches.length === 0) {
    return [{ id: newId(), ts: fallbackTs, text: trimmed }];
  }

  const entries = [];
  // Preamble: text before the first marker becomes its own entry, dated by fallback.
  if (matches[0].index > 0) {
    const preamble = trimmed.slice(0, matches[0].index).trim();
    if (preamble) entries.push({ id: newId(), ts: fallbackTs, text: preamble });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].index : trimmed.length;
    const text = trimmed.slice(start, end).trim();
    if (!text) continue;
    entries.push({
      id: newId(),
      ts: `${matches[i].date}T00:00:00.000Z`,
      text,
    });
  }
  return entries;
}

// Hydrate a buyer with a noteLog. Idempotent — safe to call repeatedly.
export function migrateNoteLog(buyer) {
  if (!buyer) return buyer;
  if (Array.isArray(buyer.noteLog)) return buyer;
  const fallbackTs = buyer.lastAnalyzed || new Date().toISOString();
  const noteLog = parseLegacyNotes(buyer.notes, fallbackTs);
  return { ...buyer, noteLog };
}

export function appendNote(buyer, text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return buyer;
  const base = Array.isArray(buyer.noteLog) ? buyer.noteLog : migrateNoteLog(buyer).noteLog;
  const entry = { id: newId(), ts: new Date().toISOString(), text: trimmed };
  return { ...buyer, noteLog: [...base, entry] };
}

// Chronological log the AI receives. Most recent at the bottom so a left-to-right
// reader sees the trajectory of intel.
export function formatTimelineForAI(noteLog) {
  if (!Array.isArray(noteLog) || noteLog.length === 0) return '';
  return noteLog
    .map(e => `[${(e.ts || '').slice(0, 10)}] ${e.text}`)
    .join('\n');
}

// Returns the id of the most recent entry, or null. Used by rescanOne to mark
// which note triggered the rescan in aiHistory.
export function latestNoteId(noteLog) {
  if (!Array.isArray(noteLog) || noteLog.length === 0) return null;
  return noteLog[noteLog.length - 1].id;
}

// Format a relative time string for the timeline UI. Falls back to ISO date.
export function relativeTime(ts, now = Date.now()) {
  if (!ts) return '';
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
