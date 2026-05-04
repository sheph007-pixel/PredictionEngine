import { File as BufferFile } from 'node:buffer';
if (typeof globalThis.File === 'undefined') globalThis.File = BufferFile;

import express from 'express';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import multer from 'multer';
import pg from 'pg';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { precedentSummary } from './src/data/precedents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '8mb' }));

const client = new Anthropic();
const MODEL = 'claude-opus-4-7';
const FILES_BETA = 'files-api-2025-04-14';

// OpenAI is used ONLY for live web search before each rescan, feeding fresh
// market intel into Claude's context. Optional — if OPENAI_API_KEY is missing
// or the call fails, rescan still runs without live intel (graceful fallback).
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const LIVE_INTEL_MODEL = 'gpt-4o';

// Postgres for cross-device state sync + permanent audit log of every AI call.
// Optional — without DATABASE_URL the app falls back to localStorage-only mode.
const dbUrl = process.env.DATABASE_URL;
const pool = dbUrl
  ? new pg.Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
    })
  : null;
const WORKSPACE_ID = 'default';

async function initDb() {
  if (!pool) {
    console.log('No DATABASE_URL — running without persistence layer');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        ebitda NUMERIC NOT NULL DEFAULT 18,
        case_mode TEXT NOT NULL DEFAULT 'mid',
        market JSONB NOT NULL DEFAULT '{}',
        market_meta TEXT,
        rationales JSONB DEFAULT '{}',
        process JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS buyers (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE IF NOT EXISTS rescan_log (
        id BIGSERIAL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        scope TEXT,
        only_buyer_id TEXT,
        input JSONB,
        output JSONB,
        live_intel TEXT,
        duration_ms INT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS rescan_log_ts_idx ON rescan_log (workspace_id, ts DESC);
    `);
    console.log('DB schema ready');
  } catch (err) {
    console.error('DB init failed — continuing without persistence:', err.message);
  }
}

// Fire-and-forget audit log writer — does not block the rescan response.
function logRescan({ scope, only_buyer_id, input, output, live_intel, duration_ms, error }) {
  if (!pool) return;
  pool.query(
    `INSERT INTO rescan_log (workspace_id, scope, only_buyer_id, input, output, live_intel, duration_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [WORKSPACE_ID, scope, only_buyer_id || null, input, output, live_intel || null, duration_ms || null, error || null]
  ).catch(err => console.warn('rescan_log write failed:', err.message));
}

const RESCAN_SYSTEM_PROMPT = `You are the Kennion Prediction Engine — a senior M&A advisor's AI co-pilot for the sell-side process of Kennion's Benefits Program (a captive-style benefits brokerage advised by Reagan Consulting, currently in the Spring 2026 sale process). The actual current LTM EBITDA for the asset is provided in every user message — read it from there, do not assume a size.

# Core architecture (READ FIRST)
There is ONE asset for sale (Kennion). The market clearing multiple for that asset is set by INDUSTRY DATA, not by individual buyers — every credible buyer pays roughly within the industry band for assets of this profile. Your output has two layers:

1. GLOBAL market bands (conservative / realistic / aggressive) — these come from comps and public data. You set them ONCE per rescan based on the precedent table and public comps below. Bands apply to every buyer by default.

2. PER-BUYER scoring — for each buyer your job is mostly probability of close, fit, and thesis. DO NOT generate per-buyer multiples by default — buyers inherit the global band. The ONLY exception: if you have hard evidence (an LOI document with a firm price, a written term sheet, an explicit verbal offer logged in notes), set multiple_override on that buyer with the firm number and cite the source.

This means most buyers' rescores will leave multiple_override = null. That's correct — we don't pretend to know per-buyer pricing without evidence.

Re-evaluate using ONLY the evidence provided: buyer profile data, attached documents (CIM, LOIs, buyer emails, redlines, models), user field intelligence in notes, your own prior reasoning, and the precedent table.

${precedentSummary()}

# Citation requirement
Every buyer's reasoning MUST cite at least one precedent id from the table above (or a public comp ticker like "BRO"). The cited_precedents array lists which ids you anchored on. Do NOT invent deals not in the table — if a deal is missing, say so and the user will add it.

# Live web intel (when present)
If the user message includes a "Live web intel" section, that's fresh data fetched via OpenAI web search at the time of this rescan. It may contain summarization errors — treat it as a HINT to investigate further, not as ground truth.
- When you cite a fact from live intel, quote the source URL verbatim ("per <url>"). Do not paraphrase URLs.
- If live intel reports a NEW precedent transaction not in the table above, mention it in the rationales section but do NOT add it to cited_precedents (only the user-curated table is authoritative there). Suggest adding it in your summary.
- If live intel contradicts a precedent in the table, flag the discrepancy in your summary so the user can update the table.
- If live intel is absent or empty, fall back to the curated precedent table only.

# Global market band setting
**Size discipline (READ FIRST — this is the single biggest driver of the multiple):**
Insurance/benefits brokerage M&A multiples scale strongly with EBITDA. A sub-$5M business does NOT trade at mid-market multiples — the buyer pool is smaller, integration drag is higher, and key-person risk is real. Anchor the realistic band on the actual EBITDA bucket FIRST, then adjust for captive/niche profile, then for any deal-specific evidence:

  - **EBITDA < $3M**: realistic 4.0–6.0×, conservative 3.0–4.5×, aggressive 5.5–7.5×. Buyer universe = local strategic + small PE platforms doing tuck-ins. Treat anything above 7× as requiring hard evidence.
  - **EBITDA $3–5M**: realistic 5.0–7.0×, conservative 4.0–5.5×, aggressive 6.5–8.5×. Captive-niche profile pushes toward the lower half. This is Kennion's likely bucket if EBITDA is in this range — DO NOT use mid-market multiples here.
  - **EBITDA $5–10M**: realistic 6.5–8.5×, conservative 5.0–7.0×, aggressive 8.0–10.5×. Some PE platform interest opens up; tuck-in premium possible.
  - **EBITDA $10–20M**: realistic 8.0–10.5×, conservative 6.5–8.5×, aggressive 10.0–13.0×. Mid-market PE band starts to apply if the book is clean.
  - **EBITDA $20–50M**: realistic 10.0–12.5×, conservative 8.5–10.5×, aggressive 12.0–14.5×. Full mid-market PE / strategic platform multiples.
  - **EBITDA > $50M**: realistic 11.0–13.5×, conservative 9.5–11.5×, aggressive 13.0–16.0×. Approach scaled-broker comps with the standard private discount.

After picking the size bucket, apply these adjustments:
- **Captive / niche profile** (concentrated benefits book, smaller buyer pool): pull realistic to the lower half of the bucket band, not the upper half.
- **Public broker comps** (BRO 16×, AON 14×, etc.) are forward-EBITDA on scaled liquid platforms — apply a **3–5× discount** for private mid-market + another **1–2×** for captive/niche before using them as anchors. Do not anchor a sub-$10M private band on these directly.
- **Precedent table**: cite specific deals only when their EBITDA size is within ~2× of the asset's. The placeholder \`captive-niche-discount\` and \`mid-mkt-pe-band\` entries are sized for $15M+ targets — they DO NOT apply to sub-$10M businesses without an explicit size adjustment, which you must state in the band note.

Bands ~2× wide; bands may overlap (conservative.high may equal realistic.low). Update bands only if new evidence shifts them; otherwise echo prior_market values.

**Conservatism bias**: when evidence is thin, lean to the lower half of the bucket. It is better to surface a credible $22–29M valuation that holds up under LP scrutiny than a wishful $40M+ that collapses at LOI. Every band note must include the size bucket you used (e.g. "$3–5M EBITDA bucket · captive-niche").

# Per-buyer outputs
- probability (0–100): THIS buyer's independent odds of being the winning bidder. **The number you return IS what the UI shows — there is no post-processing, no stage multiplier applied downstream.** Bake stage, momentum, fit, evidence quality, and no-deal risk into this single number. Probabilities across buyers are independent and may sum to >100 (multiple paths to close) or <100 (significant no-deal risk). Be honest about no-deal risk.
- fit (size, benefits, precedent each 0–5; pe is 0 or 1): size capacity, benefits-vertical alignment, PE capital available, 2025–26 M&A precedent activity.
- thesis: ONE plain-English sentence, max 15 words. State why THIS buyer wins specifically. No jargon, no acronyms (spell out "PE", "LOI" etc. or omit), no em-dash run-ons. Format examples (illustrative only — do NOT copy their content, write fresh based on each buyer's actual profile + notes): "Strongest strategic fit given existing captive program experience." / "Active sponsor with capital deployed and a meeting already scheduled." / "Has capital, but this asset class isn't their typical playbook."
- reasoning: WHY this probability and fit. Reference specific notes, doc snippets, or comps. No hand-waving. This text is shown verbatim in the UI as the explanation for the number — write it for a smart LP, not for yourself.
- confidence ("low" | "medium" | "high"): how grounded this prediction is in hard evidence. "high" = LOI/term-sheet/written-offer or multiple corroborating signals from CIM/notes/live intel; "medium" = consistent pattern across notes + comps but no firm number; "low" = mostly inference from buyer profile + sponsor pattern with thin evidence.
- multiple_override: null OR { low, mid, high, source: "LOI"|"term-sheet"|"verbal-offer", evidence: "doc filename or note quote" }. Set ONLY when hard-evidence number exists. Most buyers should have null here.

# Stage discipline (probability anchors — these are the FINAL displayed ranges, not a base to be lifted)
- outreach: prob 8–22%
- nda: prob 12–28%
- chemistry: prob 18–38%
- loi: prob 28–58% (and almost always has multiple_override)
- closed: prob 90+%
- dropped: filter out — do not include in output

A buyer at the high end of their stage range should reflect strong corroborating evidence (active sponsor, recent precedent, distribution fit, momentum). A buyer at the low end should reflect specific drag (declined informally, capacity constraint, weak benefits mix, sponsor bandwidth issue). State the drivers in \`reasoning\`.

# Dashboard rationales (PLAIN ENGLISH — short, direct, no jargon)
Write three one-liners — close_date_rationale, confidence_rationale, clearing_price_rationale — that explain each top-line number in plain English. Hard rules:

- **Max 25 words** each. Count them. Brevity is more important than completeness.
- **Two short sentences max** (one is fine).
- **Plain English**. No banker jargon ("LOI cycle", "exclusivity", "bidding tension", "tuck-in math", "anchored on the bucket"). If a smart non-banker wouldn't get it, rewrite it.
- **State the why directly**. Don't "defend" — just explain what's driving the number and the main risk.
- **No first-person plural** ("we", "our process"). Just say what's happening.

Format examples (illustrative only — do NOT copy buyer names, dates, percentages, or specific facts from these examples; they are abstract format demos. Use ONLY information from the actual pipeline state, notes, docs, and precedent table provided in this rescan call):

  close_date_rationale: "Targeting Q3 2026: most buyers are mid-stage and offers usually land 8–10 weeks out. The lead buyer's next milestone is the biggest swing factor."
  confidence_rationale: "Multiple buyers above 15% give independent paths to close. Main no-deal risk is the top buyers walking on price."
  clearing_price_rationale: "Sized at 6–7× EBITDA because the book is sub-$5M and concentrated. Higher only if a buyer puts real synergies in writing."

**Strict rule**: do not invent specifics. If the examples reference a date, milestone, sponsor, or percentage that is NOT in the actual pipeline state below, do not include it. Reference only buyers, dates, notes, and documents that are present in this rescan's input.

These rationales must reflect the CURRENT pipeline state in this rescan call. If a per-buyer rescan changed only one buyer, update the rationales only if the change is material to the dashboard number; otherwise echo prior values.

# Output discipline
Call apply_rescan exactly once. Do not output prose outside the tool call. Be opinionated but every claim must trace to evidence. If evidence is insufficient to move a number, leave it stable and say so in reasoning.`;

const RESCAN_TOOL = {
  name: 'apply_rescan',
  description: 'Apply a re-evaluation of one or more buyers in the pipeline based on all available context (buyer profiles, attached documents, user field intelligence, prior reasoning).',
  input_schema: {
    type: 'object',
    required: ['market', 'buyers', 'summary', 'close_date_rationale', 'confidence_rationale', 'clearing_price_rationale'],
    properties: {
      market: {
        type: 'object',
        required: ['conservative', 'mid', 'aggressive'],
        properties: {
          conservative: {
            type: 'object',
            required: ['low', 'high', 'note'],
            properties: {
              low: { type: 'number' },
              high: { type: 'number' },
              note: { type: 'string', description: '<= 60 chars · what this band reflects' },
            },
          },
          mid: {
            type: 'object',
            required: ['low', 'high', 'note'],
            properties: {
              low: { type: 'number' },
              high: { type: 'number' },
              note: { type: 'string' },
            },
          },
          aggressive: {
            type: 'object',
            required: ['low', 'high', 'note'],
            properties: {
              low: { type: 'number' },
              high: { type: 'number' },
              note: { type: 'string' },
            },
          },
        },
      },
      buyers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'probability', 'fit', 'thesis', 'reasoning', 'cited_precedents', 'confidence'],
          properties: {
            id: { type: 'string' },
            probability: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: 'Independent probability THIS buyer is the winning bidder (0-100). This is the final displayed number — no post-processing.',
            },
            fit: {
              type: 'object',
              required: ['size', 'benefits', 'pe', 'precedent'],
              properties: {
                size: { type: 'integer', minimum: 0, maximum: 5 },
                benefits: { type: 'integer', minimum: 0, maximum: 5 },
                pe: { type: 'integer', minimum: 0, maximum: 1 },
                precedent: { type: 'integer', minimum: 0, maximum: 5 },
              },
            },
            thesis: { type: 'string', description: 'ONE plain-English sentence, max 15 words. Why this buyer wins. No jargon, no acronyms, no em-dash run-ons.' },
            reasoning: { type: 'string', description: 'Why this probability and fit. Reference specific notes, doc snippets, or comps. No hand-waving. Shown verbatim in the UI.' },
            confidence: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'How grounded this prediction is in hard evidence. high=LOI/term-sheet/multi-signal; medium=pattern across notes+comps; low=mostly inference.',
            },
            cited_precedents: {
              type: 'array',
              minItems: 1,
              items: { type: 'string' },
              description: 'Precedent ids or public comp tickers that anchor your view (at least one).',
            },
            multiple_override: {
              type: ['object', 'null'],
              description: 'OPTIONAL — set ONLY when there is hard evidence of a firm price for this buyer (LOI received, term sheet, explicit offer in notes). Otherwise null. Most buyers should be null.',
              required: ['low', 'mid', 'high', 'source', 'evidence'],
              properties: {
                low: { type: 'number' },
                mid: { type: 'number' },
                high: { type: 'number' },
                source: { type: 'string', enum: ['LOI', 'term-sheet', 'verbal-offer', 'written-offer'] },
                evidence: { type: 'string', description: 'Doc filename or short note quote that establishes the firm number' },
              },
            },
            citations: {
              type: 'array',
              items: { type: 'string' },
              description: 'Additional evidence: doc filenames or short note quotes.',
            },
          },
        },
      },
      summary: { type: 'string', description: '1–2 sentences on how the overall pipeline view shifted vs prior state' },
      close_date_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the projected close date. Max 25 words, two short sentences max. State what is driving the timing and the biggest risk. No jargon ("LOI cycle", "exclusivity", "process phase").',
      },
      confidence_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the deal confidence percentage. Max 25 words, two short sentences max. State the paths to close and the main no-deal risk. No jargon.',
      },
      clearing_price_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the market clearing price band. Max 25 words, two short sentences max. State the multiple, why that size bucket, and what would push it higher. No jargon ("anchored on the bucket", "tuck-in math", "captive-niche-discount").',
      },
    },
  },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024, files: 20 },
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/ai/complete', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ text: message.content[0].text });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ error: 'AI request failed' });
  }
});

// Chat endpoint with tool use + optional document attachments
app.post('/api/ai/chat', async (req, res) => {
  const { messages, system, tools, file_ids } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

  // Inject document blocks into the first user message (they then live in
  // the conversation history; subsequent turns reuse them via the prefix cache).
  let injected = messages;
  if (Array.isArray(file_ids) && file_ids.length > 0) {
    injected = messages.map((m, i) => {
      if (i !== 0 || m.role !== 'user') return m;
      const docBlocks = file_ids.map((id, j) => ({
        type: 'document',
        source: { type: 'file', file_id: id },
        ...(j === file_ids.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      }));
      const existing = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      return { ...m, content: [...docBlocks, ...existing] };
    });
  }

  try {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: system
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : undefined,
      tools: tools || undefined,
      messages: injected,
      betas: [FILES_BETA],
    });
    res.json({
      content: message.content,
      stop_reason: message.stop_reason,
      usage: message.usage,
    });
  } catch (err) {
    console.error('Anthropic chat error:', err.message);
    res.status(500).json({ error: err.message || 'AI chat failed' });
  }
});

// Fetch fresh market intel using OpenAI's web_search tool. Returns a text blob
// with cited URLs for Claude to reference. Returns null on failure / when not
// configured — caller proceeds without live intel.
async function fetchLiveMarketIntel({ buyers, scopedBuyerId }) {
  if (!openai) return null;

  const live = (buyers || []).filter(b => b.stage !== 'dropped');
  const buyerNames = scopedBuyerId
    ? [live.find(b => b.id === scopedBuyerId)?.name].filter(Boolean)
    : live.slice(0, 4).map(b => b.name);

  const today = new Date().toISOString().slice(0, 10);
  const buyerSection = buyerNames.length
    ? `\n2. M&A activity, sponsor changes, or material news in the last 6 months for these specific firms: ${buyerNames.join(', ')}.`
    : '';

  const query = `Today is ${today}. Search the web and report concrete, recent facts only:

1. U.S. insurance / benefits brokerage M&A transactions closed or announced in the last 6 months. For each, give target, acquirer, EV, and EBITDA multiple if disclosed.${buyerSection}
3. Current forward-EBITDA multiples for public broker comps (BRO, AON, MMC, AJG, WTW) — most recent sell-side or earnings-call print.

Cite every fact with a source URL inline. If a topic has no material updates, say "no material updates" — do not pad. Be terse. Skip generic background.`;

  try {
    const response = await openai.responses.create({
      model: LIVE_INTEL_MODEL,
      tools: [{ type: 'web_search' }],
      input: query,
      max_output_tokens: 1500,
    });
    const text = response.output_text || '';
    return text.trim() || null;
  } catch (err) {
    console.warn('Live market intel fetch failed:', err.message);
    return null;
  }
}

// Re-evaluate the buyer pipeline with full context (buyers + docs + notes + prior reasoning).
// Used by the top-bar Re-scan, per-buyer note submission, and post-classify doc upload.
app.post('/api/ai/rescan', async (req, res) => {
  const { buyers, ebitda, file_ids, only_buyer_id, prior_market } = req.body;
  if (!Array.isArray(buyers) || buyers.length === 0) {
    return res.status(400).json({ error: 'buyers array required' });
  }

  // Always send the full non-dropped pipeline so the AI can produce honest
  // dashboard-level rationales (close date, confidence, clearing price) even
  // when re-scoring is scoped to a single buyer.
  const livePipeline = buyers.filter(b => b.stage !== 'dropped');
  if (livePipeline.length === 0) return res.status(400).json({ error: 'no live buyers' });

  // For the buyer in scope (or all when no scope), include full grounded
  // detail including notes + history. For the rest of the pipeline, send a
  // compact summary so the AI has enough context for pipeline rationales
  // without blowing token budget.
  const fullDetail = (b) => ({
    id: b.id, name: b.name, hq: b.hq, revenue: b.revenue, headcount: b.headcount,
    offices: b.offices, ownership: b.ownership, sponsor: b.sponsor, type: b.type,
    stage: b.stage, nda_signed: b.nda_signed || null, chemistry_date: b.chemistry_date || null,
    notes: b.notes || '', flags: b.flags || [], fit: b.fit,
    probability: b.probability, thesis: b.thesis,
    multipleOverride: b.multipleOverride || null,
    aiNotes: b.aiNotes || null,
    aiHistory: (b.aiHistory || []).slice(-3),
  });
  const compactSummary = (b) => ({
    id: b.id, name: b.name, stage: b.stage, ownership: b.ownership, sponsor: b.sponsor,
    probability: b.probability, thesis: b.thesis,
    multipleOverride: b.multipleOverride || null,
  });

  const groundedBuyers = livePipeline.map(b =>
    (!only_buyer_id || b.id === only_buyer_id) ? fullDetail(b) : compactSummary(b)
  );

  const docBlocks = (file_ids || []).map((id, j, arr) => ({
    type: 'document',
    source: { type: 'file', file_id: id },
    ...(j === arr.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const focusInstruction = only_buyer_id
    ? `SCOPE: Re-score ONLY buyer "${only_buyer_id}" based on their latest notes and any new documents. Return apply_rescan with that one buyer in the buyers array. Echo the prior market values unchanged in the market field. The other buyers are shown as compact summaries solely to give you context for the dashboard-level rationales — do NOT include them in your response.`
    : `SCOPE: Re-evaluate every non-dropped buyer in the pipeline. Update market multiple bands if evidence has shifted; otherwise echo prior values.`;

  // Fetch fresh web intel BEFORE Claude's rescan. Runs in parallel-style with
  // Anthropic call setup; non-fatal on failure.
  const liveIntel = await fetchLiveMarketIntel({ buyers: livePipeline, scopedBuyerId: only_buyer_id });

  const sizeBucket =
    ebitda < 3 ? '<$3M (sub-scale, local strategics + small PE tuck-ins only)'
    : ebitda < 5 ? '$3–5M (captive-niche bucket, sub-mid-market multiples)'
    : ebitda < 10 ? '$5–10M (lower mid-market, limited PE platform interest)'
    : ebitda < 20 ? '$10–20M (mid-market PE band starts to apply)'
    : ebitda < 50 ? '$20–50M (full mid-market PE / strategic platform)'
    : '>$50M (scaled-platform comps with private discount)';
  const userText = `# Pipeline state
EBITDA: $${ebitda}M (locked, set by Reagan — do not adjust)
Size bucket: ${sizeBucket}
**Reminder: anchor the realistic multiple band on this bucket FIRST. Do not apply mid-market or scaled-broker multiples to a sub-$10M asset without explicit hard evidence (LOI, term sheet, written offer).**

# Prior market multiples (echo if no shift evidence)
${JSON.stringify(prior_market || {}, null, 2)}

# Buyers in scope
${JSON.stringify(groundedBuyers, null, 2)}

${docBlocks.length > 0 ? `# Documents attached: ${docBlocks.length} (CIM, LOIs, emails, etc. — read them as evidence)` : '# No documents attached yet.'}

${liveIntel ? `# Live web intel (fetched ${new Date().toISOString().slice(0,10)} via OpenAI web search — may contain summarization errors, treat as a hint not ground truth; cite source URLs verbatim when used)
${liveIntel}
` : '# Live web intel: unavailable for this rescan.'}

${focusInstruction}`;

  const t0 = Date.now();
  const auditInput = {
    ebitda,
    file_ids: file_ids || [],
    only_buyer_id: only_buyer_id || null,
    buyer_ids_in_scope: groundedBuyers.map(b => b.id),
    user_text: userText,
  };
  try {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: [
        { type: 'text', text: RESCAN_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [RESCAN_TOOL],
      tool_choice: { type: 'tool', name: 'apply_rescan' },
      messages: [{
        role: 'user',
        content: [...docBlocks, { type: 'text', text: userText }],
      }],
      betas: [FILES_BETA],
    });

    const toolUse = message.content.find(b => b.type === 'tool_use' && b.name === 'apply_rescan');
    if (!toolUse) {
      console.error('Rescan: no tool_use in response', message.content);
      logRescan({
        scope: only_buyer_id ? 'buyer' : 'pipeline',
        only_buyer_id,
        input: auditInput,
        output: null,
        live_intel: liveIntel,
        duration_ms: Date.now() - t0,
        error: 'no tool_use in response',
      });
      return res.status(502).json({ error: 'AI did not return structured output' });
    }

    const responsePayload = {
      ...toolUse.input,
      usage: message.usage,
      ts: new Date().toISOString(),
      live_intel_used: !!liveIntel,
    };

    const validation = validateRescanShape(responsePayload, only_buyer_id);
    if (!validation.ok) {
      const stopReason = message.stop_reason || 'unknown';
      const truncated = stopReason === 'max_tokens';
      console.error(
        `Rescan: malformed AI output — ${validation.error} (stop_reason=${stopReason}${truncated ? ', LIKELY TRUNCATED — bump max_tokens' : ''})`,
        JSON.stringify(toolUse.input).slice(0, 800)
      );
      logRescan({
        scope: only_buyer_id ? 'buyer' : 'pipeline',
        only_buyer_id,
        input: auditInput,
        output: responsePayload,
        live_intel: liveIntel,
        duration_ms: Date.now() - t0,
        error: `malformed: ${validation.error} (stop_reason=${stopReason})`,
      });
      return res.status(502).json({
        error: `AI returned incomplete output: ${validation.error}${truncated ? ' (response truncated — try again)' : ''}`,
        type: 'malformed_output',
        stop_reason: stopReason,
      });
    }

    res.json(responsePayload);
    logRescan({
      scope: only_buyer_id ? 'buyer' : 'pipeline',
      only_buyer_id,
      input: auditInput,
      output: responsePayload,
      live_intel: liveIntel,
      duration_ms: Date.now() - t0,
    });
  } catch (err) {
    const detail = describeAnthropicError(err);
    console.error('Rescan error:', detail.full);
    logRescan({
      scope: only_buyer_id ? 'buyer' : 'pipeline',
      only_buyer_id,
      input: auditInput,
      output: null,
      live_intel: liveIntel,
      duration_ms: Date.now() - t0,
      error: detail.full,
    });
    res.status(detail.status).json({
      error: detail.message,
      type: detail.type,
      request_id: detail.request_id,
    });
  }
});

// Anthropic SDK errors stringify as the full HTTP body. Pull the useful bits
// out so the client gets a short message and we still log the full detail.
function describeAnthropicError(err) {
  const status = typeof err?.status === 'number' ? err.status : 500;
  const body = err?.error?.error || err?.error || null;
  const type = body?.type || err?.name || 'rescan_error';
  const baseMsg = body?.message || err?.message || 'rescan failed';
  const request_id =
    err?.request_id ||
    err?.error?.request_id ||
    err?.headers?.['request-id'] ||
    err?.headers?.['x-request-id'] ||
    null;
  // Strip the "401 {...json...}" prefix the SDK puts on err.message so users
  // see "invalid x-api-key" rather than the raw JSON envelope.
  const message = baseMsg.replace(/^\d{3}\s*\{[^]*"message":"([^"]+)".*$/, '$1');
  return {
    status,
    type,
    message,
    request_id,
    full: `[${status} ${type}] ${message}${request_id ? ` (req ${request_id})` : ''}`,
  };
}

// Server-side shape check that mirrors validateRescan in src/lib/ai-engine.js
// but runs against the live tool_use payload so we can name the missing field
// and log the offending output. Per-buyer rescans skip the market check (the
// AI is told to echo prior_market in that flow but sometimes omits it; the
// client merges by id so missing market is non-fatal there).
function validateRescanShape(p, onlyBuyerId) {
  if (!p) return { ok: false, error: 'empty payload' };
  if (!onlyBuyerId) {
    if (!p.market || typeof p.market !== 'object') return { ok: false, error: 'missing market' };
    for (const c of ['conservative', 'mid', 'aggressive']) {
      const b = p.market[c];
      if (!b || typeof b.low !== 'number' || typeof b.high !== 'number') {
        return { ok: false, error: `market.${c} missing low/high` };
      }
    }
  }
  if (!Array.isArray(p.buyers) || p.buyers.length === 0) return { ok: false, error: 'missing buyers' };
  for (const b of p.buyers) {
    if (!b?.id) return { ok: false, error: 'buyer missing id' };
    if (typeof b.probability !== 'number') return { ok: false, error: `buyer ${b.id} missing probability` };
    if (typeof b.thesis !== 'string') return { ok: false, error: `buyer ${b.id} missing thesis` };
    if (typeof b.reasoning !== 'string') return { ok: false, error: `buyer ${b.id} missing reasoning` };
    if (!b.fit) return { ok: false, error: `buyer ${b.id} missing fit` };
    if (!Array.isArray(b.cited_precedents) || b.cited_precedents.length === 0) {
      return { ok: false, error: `buyer ${b.id} missing cited_precedents` };
    }
  }
  if (typeof p.summary !== 'string') return { ok: false, error: 'missing summary' };
  if (typeof p.close_date_rationale !== 'string') return { ok: false, error: 'missing close_date_rationale' };
  if (typeof p.confidence_rationale !== 'string') return { ok: false, error: 'missing confidence_rationale' };
  if (typeof p.clearing_price_rationale !== 'string') return { ok: false, error: 'missing clearing_price_rationale' };
  return { ok: true };
}

// ───────────────────────────── Workspace state sync ─────────────────────────
// Single-tenant workspace persistence + AI audit log query. Without DATABASE_URL
// these endpoints return 503 and the client falls back to localStorage-only.

function ensureDb(res) {
  if (!pool) {
    res.status(503).json({ error: 'persistence unavailable' });
    return false;
  }
  return true;
}

// Latest rescan log row, scoped to a buyer if buyer_id provided. Used by the
// modal Research card to show the live web intel + raw AI output backing the
// number a user is looking at.
app.get('/api/rescan-log/latest', async (req, res) => {
  if (!ensureDb(res)) return;
  const buyerId = typeof req.query.buyer_id === 'string' ? req.query.buyer_id : null;
  try {
    // Prefer a per-buyer rescan if one exists; otherwise fall back to the most
    // recent pipeline-wide rescan that included this buyer (or any rescan if
    // buyerId is null).
    let row = null;
    if (buyerId) {
      const perBuyer = await pool.query(
        `SELECT ts, scope, only_buyer_id, output, live_intel, duration_ms, error
         FROM rescan_log
         WHERE workspace_id = $1 AND only_buyer_id = $2 AND error IS NULL
         ORDER BY ts DESC LIMIT 1`,
        [WORKSPACE_ID, buyerId],
      );
      row = perBuyer.rows[0] || null;
    }
    if (!row) {
      const fallback = await pool.query(
        `SELECT ts, scope, only_buyer_id, output, live_intel, duration_ms, error
         FROM rescan_log
         WHERE workspace_id = $1 AND error IS NULL
         ORDER BY ts DESC LIMIT 1`,
        [WORKSPACE_ID],
      );
      row = fallback.rows[0] || null;
    }
    res.json({ entry: row });
  } catch (err) {
    console.error('GET /api/rescan-log/latest error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace', async (_req, res) => {
  if (!ensureDb(res)) return;
  try {
    const wsRow = await pool.query(`SELECT * FROM workspace WHERE id = $1`, [WORKSPACE_ID]);
    const buyersRows = await pool.query(`SELECT id, data, updated_at FROM buyers WHERE workspace_id = $1`, [WORKSPACE_ID]);
    const ws = wsRow.rows[0] || null;
    res.json({
      workspace: ws ? {
        ebitda: Number(ws.ebitda),
        case_mode: ws.case_mode,
        market: ws.market,
        market_meta: ws.market_meta,
        rationales: ws.rationales,
        process: ws.process,
        updated_at: ws.updated_at,
      } : null,
      buyers: buyersRows.rows.map(r => ({ ...r.data, updated_at: r.updated_at })),
    });
  } catch (err) {
    console.error('GET /api/workspace error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/workspace', async (req, res) => {
  if (!ensureDb(res)) return;
  const { ebitda, case_mode, market, market_meta, rationales, process: proc } = req.body || {};
  try {
    await pool.query(`
      INSERT INTO workspace (id, ebitda, case_mode, market, market_meta, rationales, process, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, now())
      ON CONFLICT (id) DO UPDATE SET
        ebitda = COALESCE(EXCLUDED.ebitda, workspace.ebitda),
        case_mode = COALESCE(EXCLUDED.case_mode, workspace.case_mode),
        market = COALESCE(EXCLUDED.market, workspace.market),
        market_meta = COALESCE(EXCLUDED.market_meta, workspace.market_meta),
        rationales = COALESCE(EXCLUDED.rationales, workspace.rationales),
        process = COALESCE(EXCLUDED.process, workspace.process),
        updated_at = now()
    `, [WORKSPACE_ID, ebitda ?? null, case_mode ?? null, market ?? null, market_meta ?? null, rationales ?? null, proc ?? null]);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/workspace error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Bulk replace buyers (used after rescans + on initial migration from localStorage).
app.put('/api/buyers', async (req, res) => {
  if (!ensureDb(res)) return;
  const buyers = Array.isArray(req.body?.buyers) ? req.body.buyers : null;
  if (!buyers) return res.status(400).json({ error: 'buyers array required' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`DELETE FROM buyers WHERE workspace_id = $1`, [WORKSPACE_ID]);
    for (const b of buyers) {
      if (!b?.id) continue;
      await c.query(
        `INSERT INTO buyers (workspace_id, id, data) VALUES ($1, $2, $3)`,
        [WORKSPACE_ID, b.id, b]
      );
    }
    await c.query('COMMIT');
    res.json({ ok: true, count: buyers.length });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('PUT /api/buyers error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    c.release();
  }
});

// Paginated AI audit log — newest first. Each row is a single rescan call.
app.get('/api/rescans', async (req, res) => {
  if (!ensureDb(res)) return;
  const limit = Math.min(parseInt(req.query.limit) || 25, 100);
  try {
    const rows = await pool.query(
      `SELECT id, ts, scope, only_buyer_id, input, output, live_intel, duration_ms, error
         FROM rescan_log
         WHERE workspace_id = $1
         ORDER BY ts DESC
         LIMIT $2`,
      [WORKSPACE_ID, limit]
    );
    res.json({ rescans: rows.rows });
  } catch (err) {
    console.error('GET /api/rescans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload one or more files to Anthropic Files API.
app.post('/api/files/upload', upload.array('files', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'no files' });

  try {
    const results = await Promise.all(req.files.map(async (f) => {
      const file = await toFile(f.buffer, f.originalname, { type: f.mimetype });
      const uploaded = await client.beta.files.upload({ file }, { betas: [FILES_BETA] });
      return {
        id: uploaded.id,
        filename: uploaded.filename || f.originalname,
        mime_type: uploaded.mime_type || f.mimetype,
        size_bytes: uploaded.size_bytes || f.size,
        created_at: uploaded.created_at || new Date().toISOString(),
      };
    }));
    res.json({ files: results });
  } catch (err) {
    console.error('Files upload error:', err.message);
    res.status(500).json({ error: err.message || 'upload failed' });
  }
});

// AI-classify a single uploaded file: detect type, associated buyers, summary.
app.post('/api/files/classify', async (req, res) => {
  const { file_id, filename, buyer_names } = req.body;
  if (!file_id) return res.status(400).json({ error: 'file_id required' });

  const sys = `You are classifying documents in the Kennion Prediction Engine — a deal-tracking workspace for the sale of Kennion's Benefits Program. The user just uploaded a document. Read it and return ONLY a JSON object — no markdown, no commentary — with this exact shape:
{
  "doc_type": "CIM" | "LOI" | "NDA" | "buyer_email" | "financial_model" | "market_analysis" | "due_diligence" | "redline" | "other",
  "title": "string · concise human-readable title",
  "summary": "string · 1-2 sentence summary",
  "associated_buyers": [<buyer_id strings, only from the provided list, or empty array>],
  "key_points": [<2-4 short bullet strings>]
}
Buyer ids available: ${(buyer_names || []).map(b => `"${b.id}" (${b.name})`).join(', ') || 'none'}.
Filename: ${filename || '(none)'}.`;

  try {
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: sys,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id } },
          { type: 'text', text: 'Classify this document. Return JSON only.' },
        ],
      }],
      betas: [FILES_BETA],
    });
    const txt = msg.content.find(b => b.type === 'text')?.text || '{}';
    const cleaned = txt.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { parsed = { doc_type: 'other', title: filename || 'Untitled', summary: cleaned.slice(0, 200), associated_buyers: [], key_points: [] }; }
    res.json(parsed);
  } catch (err) {
    console.error('Classify error:', err.message);
    res.status(500).json({ error: err.message || 'classify failed' });
  }
});

app.delete('/api/files/:id', async (req, res) => {
  try {
    await client.beta.files.delete(req.params.id, { betas: [FILES_BETA] });
    res.json({ ok: true });
  } catch (err) {
    console.error('Files delete error:', err.message);
    res.status(500).json({ error: err.message || 'delete failed' });
  }
});

// Serve Vite build in production
const distPath = join(__dirname, 'dist');
if (process.env.NODE_ENV === 'production' && existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => res.sendFile(join(distPath, 'index.html')));
}

const PORT = process.env.PORT || 3001;
initDb().finally(() => {
  app.listen(PORT, () => console.log(`Server on port ${PORT}`));
});
