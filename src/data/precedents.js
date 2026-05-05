// Public broker comps — light reference for the AI's market band.
// These are listed equities; refresh quarterly when sell-side updates target
// multiples. The Re-scan engine injects the summary string below into the
// system prompt so Claude has up-to-date public anchors when setting bands.
//
// We intentionally do NOT maintain a private "precedent transactions" table.
// The size-bucket discipline in the system prompt + these public comps + live
// web intel + the uploaded CIM are enough to set a credible band — adding a
// stale comp table just gives the AI fake numbers to anchor on.

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

export function publicCompsSummary(bands = PUBLIC_COMP_BANDS) {
  const lines = [`# PUBLIC BROKER COMPS (forward EBITDA, as of ${bands.asof})`];
  for (const c of bands.comps) {
    lines.push(`- ${c.ticker} (${c.name}): ${c.fwd_ebitda_mult}× fwd EBITDA`);
  }
  lines.push(`(${bands.notes})`);
  return lines.join('\n');
}

// Lookup table for the UI to render public-comp citation badges (kept for
// backward compat — components.jsx still references it).
export const PUBLIC_COMP_BY_TICKER = Object.fromEntries(PUBLIC_COMP_BANDS.comps.map(c => [c.ticker, c]));
