import { File as BufferFile } from 'node:buffer';
if (typeof globalThis.File === 'undefined') globalThis.File = BufferFile;

import express from 'express';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import multer from 'multer';
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

const RESCAN_SYSTEM_PROMPT = `You are the Kennion Prediction Engine — a senior M&A advisor's AI co-pilot for the sell-side process of Kennion's Benefits Program (a captive-style benefits brokerage at ~$18M EBITDA, advised by Reagan Consulting, currently in the Spring 2026 sale process).

# Core architecture (READ FIRST)
There is ONE asset for sale (Kennion). The market clearing multiple for that asset is set by INDUSTRY DATA, not by individual buyers — every credible buyer pays roughly within the industry band for assets of this profile. Your output has two layers:

1. GLOBAL market bands (conservative / realistic / aggressive) — these come from comps and public data. You set them ONCE per rescan based on the precedent table and public comps below. Bands apply to every buyer by default.

2. PER-BUYER scoring — for each buyer your job is mostly probability of close, fit, and thesis. DO NOT generate per-buyer multiples by default — buyers inherit the global band. The ONLY exception: if you have hard evidence (an LOI document with a firm price, a written term sheet, an explicit verbal offer logged in notes), set multiple_override on that buyer with the firm number and cite the source.

This means most buyers' rescores will leave multiple_override = null. That's correct — we don't pretend to know per-buyer pricing without evidence.

Re-evaluate using ONLY the evidence provided: buyer profile data, attached documents (CIM, LOIs, buyer emails, redlines, models), user field intelligence in notes, your own prior reasoning, and the precedent table.

${precedentSummary()}

# Citation requirement
Every buyer's reasoning MUST cite at least one precedent id from the table above (or a public comp ticker like "BRO"). The cited_precedents array lists which ids you anchored on. Do NOT invent deals not in the table — if a deal is missing, say so and the user will add it.

# Global market band setting
Set conservative / realistic / aggressive {low, high} bands based on:
- Public broker comps (forward EBITDA basis), discounted 2–4× for private mid-market and another 1–2× for captive/niche profile.
- Precedent transactions in the table that match Kennion's profile (mid-market, benefits-heavy, captive-style).
- Default anchor: realistic band centered on captive-niche-discount or mid-mkt-pe-band placeholders unless precedents have been updated.
- Each band ~2× wide; bands overlap (conservative.high may equal realistic.low, etc.).
- Update bands only if new evidence shifts them; otherwise echo prior_market values.

# Per-buyer outputs
- probability (0–100): THIS buyer's independent odds of being the winning bidder. Probabilities across buyers are independent — they may sum to >100 (multiple paths to close) or <100 (significant no-deal risk). Be honest about no-deal risk.
- fit (size, benefits, precedent each 0–5; pe is 0 or 1): size capacity, benefits-vertical alignment, PE capital available, 2025–26 M&A precedent activity.
- thesis: 1 crisp sentence — bull case for THIS buyer winning specifically.
- reasoning: WHY this probability and fit. Reference specific notes, doc snippets, or comps. No hand-waving.
- multiple_override: null OR { low, mid, high, source: "LOI"|"term-sheet"|"verbal-offer", evidence: "doc filename or note quote" }. Set ONLY when hard-evidence number exists. Most buyers should have null here.

# Stage discipline (probability anchors)
- outreach: prob 8–22%
- nda: prob 12–28%
- chemistry: prob 18–38%
- loi: prob 28–58% (and almost always has multiple_override)
- closed: prob 90+%
- dropped: filter out — do not include in output

# Output discipline
Call apply_rescan exactly once. Do not output prose outside the tool call. Be opinionated but every claim must trace to evidence. If evidence is insufficient to move a number, leave it stable and say so in reasoning.`;

const RESCAN_TOOL = {
  name: 'apply_rescan',
  description: 'Apply a re-evaluation of one or more buyers in the pipeline based on all available context (buyer profiles, attached documents, user field intelligence, prior reasoning).',
  input_schema: {
    type: 'object',
    required: ['market', 'buyers', 'summary'],
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
          required: ['id', 'probability', 'fit', 'thesis', 'reasoning', 'cited_precedents'],
          properties: {
            id: { type: 'string' },
            probability: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: 'Independent probability THIS buyer is the winning bidder (0-100).',
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
            thesis: { type: 'string', description: '1 sentence bull case for this buyer winning' },
            reasoning: { type: 'string', description: 'Why this probability and fit. Reference specific notes, doc snippets, or comps. No hand-waving.' },
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

// Re-evaluate the buyer pipeline with full context (buyers + docs + notes + prior reasoning).
// Used by the top-bar Re-scan, per-buyer note submission, and post-classify doc upload.
app.post('/api/ai/rescan', async (req, res) => {
  const { buyers, ebitda, file_ids, only_buyer_id, prior_market } = req.body;
  if (!Array.isArray(buyers) || buyers.length === 0) {
    return res.status(400).json({ error: 'buyers array required' });
  }

  const targetBuyers = only_buyer_id
    ? buyers.filter(b => b.id === only_buyer_id)
    : buyers.filter(b => b.stage !== 'dropped');
  if (targetBuyers.length === 0) return res.status(400).json({ error: 'no buyers in scope' });

  // Strip transient/UI-only fields and cap aiHistory to last 3 entries to keep tokens bounded.
  const groundedBuyers = targetBuyers.map(b => ({
    id: b.id,
    name: b.name,
    hq: b.hq,
    revenue: b.revenue,
    headcount: b.headcount,
    offices: b.offices,
    ownership: b.ownership,
    sponsor: b.sponsor,
    type: b.type,
    stage: b.stage,
    nda_signed: b.nda_signed || null,
    chemistry_date: b.chemistry_date || null,
    notes: b.notes || '',
    flags: b.flags || [],
    fit: b.fit,
    multiple: b.multiple,
    probability: b.probability,
    thesis: b.thesis,
    aiNotes: b.aiNotes || null,
    aiHistory: (b.aiHistory || []).slice(-3),
  }));

  const docBlocks = (file_ids || []).map((id, j, arr) => ({
    type: 'document',
    source: { type: 'file', file_id: id },
    ...(j === arr.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const focusInstruction = only_buyer_id
    ? `SCOPE: Re-score ONLY buyer "${only_buyer_id}" based on their latest notes and any new documents. Return apply_rescan with that one buyer in the buyers array. Echo the prior market values unchanged in the market field.`
    : `SCOPE: Re-evaluate every non-dropped buyer in the pipeline. Update market multiple bands if evidence has shifted; otherwise echo prior values.`;

  const userText = `# Pipeline state
EBITDA: $${ebitda}M (locked, set by Reagan — do not adjust)

# Prior market multiples (echo if no shift evidence)
${JSON.stringify(prior_market || {}, null, 2)}

# Buyers in scope
${JSON.stringify(groundedBuyers, null, 2)}

${docBlocks.length > 0 ? `# Documents attached: ${docBlocks.length} (CIM, LOIs, emails, etc. — read them as evidence)` : '# No documents attached yet.'}

${focusInstruction}`;

  try {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4096,
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
      return res.status(502).json({ error: 'AI did not return structured output' });
    }

    res.json({
      ...toolUse.input,
      usage: message.usage,
      ts: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Rescan error:', err.message);
    res.status(500).json({ error: err.message || 'rescan failed' });
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
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
