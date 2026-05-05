// Precedent transactions and public comps — the AI's grounding source.
//
// ───────────────────────────────────────────────────────────────────
//  THIS FILE IS THE FALLBACK SEED ONLY.
//  In production, the precedent table is loaded from the `precedents`
//  Postgres table (workspace-scoped) and is edited in-app via the
//  PrecedentEditor (⚙ Tweaks → "Edit precedents"). The rows below are
//  used only when:
//    - DATABASE_URL is unset (local dev), OR
//    - the precedents table is empty (first boot)
//  Edit precedents IN THE APP. Do not anchor production decisions on
//  the placeholders here — replace them with Reagan's real comps.
// ───────────────────────────────────────────────────────────────────
//
// HOW TO MAINTAIN
//   - Open the app → ⚙ Tweaks → "Edit precedents" — add/edit/delete rows.
//   - The Re-scan engine pulls precedents from the DB on every call.
//   - Update PUBLIC_COMP_BANDS quarterly with fresh forward-EBITDA prints.
//   - Mark each entry `confidence: 'verified'` (credible source) or
//     `confidence: 'estimate'` (placeholder; the editor shows a banner).
//   - The AI cannot cite a precedent that isn't in the active table.

export const PRECEDENTS = [
  // ─── Public deals (broadly reported in press / filings) ────────────
  {
    id: 'nfp-aon-2024',
    label: 'NFP → Aon (2024)',
    target: 'NFP Corp',
    acquirer: 'Aon plc',
    closed: '2024-04',
    ev_b: 13.4,
    multiple_ltm_ebitda: null, // EV widely reported; precise EBITDA basis varies
    multiple_note: 'Press reports cluster at ~22-26× LTM but EBITDA basis disclosed inconsistently',
    type: 'strategic-public',
    segment: 'large diversified broker',
    benefits_mix: 'mixed (~40% benefits)',
    notes: 'Public M&A — useful as a CEILING reference for scaled strategic premium. Do not anchor mid-market private targets on this.',
    confidence: 'verified',
  },

  // ─── Aggregate bands (placeholders — REPLACE with Reagan intel) ────
  // These are conservative starting placeholders so the engine has
  // something to anchor on before you've populated the table. They
  // intentionally err low. Replace each with the SPECIFIC deals Reagan
  // has shared that map to Kennion's profile.
  {
    id: 'mid-mkt-pe-band',
    label: 'Mid-market PE benefits broker LBO band (placeholder)',
    target: '$250M-1B revenue benefits/diversified targets',
    acquirer: 'Various PE platforms',
    closed: '2024-2025',
    ev_b: null,
    multiple_ltm_ebitda: 12,
    multiple_note: 'Wide-range placeholder; replace with specific deals from Reagan',
    type: 'aggregate-band',
    segment: 'mid-market broker',
    benefits_mix: 'mixed',
    notes: 'PLACEHOLDER. Real comps from Reagan should replace this. Typical 11-14× LTM cited in press for the segment, but specific deal multiples are private.',
    confidence: 'estimate',
  },
  {
    id: 'captive-niche-discount',
    label: 'Captive / niche benefits book band (placeholder)',
    target: 'Captive specialists, concentrated benefits books',
    acquirer: 'Various',
    closed: '2024-2025',
    ev_b: null,
    multiple_ltm_ebitda: 10.5,
    multiple_note: 'Placeholder anchor for Kennion-style profile',
    type: 'aggregate-band',
    segment: 'niche / captive',
    benefits_mix: 'concentrated',
    notes: 'PLACEHOLDER. Captive specialists typically clear 1-2× below scaled brokers due to smaller buyer pool, integration risk, customer concentration. Replace with specific captive-broker comps when available.',
    confidence: 'estimate',
  },
];

// Public broker comps — these ARE public (listed equities).
// Refresh quarterly when sell-side updates their target multiples.
export const PUBLIC_COMP_BANDS = {
  asof: '2026-04-30',
  source: 'User-maintained — refresh from sell-side research / Bloomberg quarterly',
  comps: [
    { ticker: 'BRO',  name: 'Brown & Brown',         fwd_ebitda_mult: 16   },
    { ticker: 'AON',  name: 'Aon',                   fwd_ebitda_mult: 14   },
    { ticker: 'MMC',  name: 'Marsh McLennan',        fwd_ebitda_mult: 15.5 },
    { ticker: 'AJG',  name: 'Arthur J. Gallagher',   fwd_ebitda_mult: 15.5 },
    { ticker: 'WTW',  name: 'Willis Towers Watson',  fwd_ebitda_mult: 13.5 },
    { ticker: 'BWIN', name: 'Baldwin / CAC',         fwd_ebitda_mult: 13   },
  ],
  notes: 'Forward EBITDA multiples for listed brokers. Private mid-market targets typically trade at a 2-4× discount to this band due to scale, liquidity, and information asymmetry — do not anchor private target multiples directly on these without applying that discount.',
};

// Compact summary string the server injects into the cached system prompt.
export function precedentSummary({ precedents = PRECEDENTS, publicComps = PUBLIC_COMP_BANDS } = {}) {
  const lines = ['# PRECEDENT TRANSACTIONS (cite by id in cited_precedents array)'];
  if (precedents.length === 0) {
    lines.push('(none provided yet — user must populate from Reagan precedent deck)');
  } else {
    for (const p of precedents) {
      const multStr = p.multiple_ltm_ebitda != null ? `${p.multiple_ltm_ebitda}× LTM` : (p.multiple_note || '—');
      const evStr = p.ev_b != null ? `$${p.ev_b}B EV` : 'aggregate band';
      lines.push(`- id="${p.id}" · ${p.label} · ${evStr} · ${multStr} · ${p.segment} · [${p.confidence}]`);
      lines.push(`  ${p.notes}`);
    }
  }
  lines.push('');
  lines.push(`# PUBLIC BROKER COMPS (forward EBITDA, as of ${publicComps.asof})`);
  for (const c of publicComps.comps) {
    lines.push(`- ${c.ticker} (${c.name}): ${c.fwd_ebitda_mult}× fwd EBITDA`);
  }
  lines.push(`(${publicComps.notes})`);
  return lines.join('\n');
}

// Lookup table for the UI to render citation badges.
export const PRECEDENT_BY_ID = Object.fromEntries(PRECEDENTS.map(p => [p.id, p]));
