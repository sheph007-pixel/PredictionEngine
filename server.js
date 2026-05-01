import { File as BufferFile } from 'node:buffer';
if (typeof globalThis.File === 'undefined') globalThis.File = BufferFile;

import express from 'express';
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

const client = new Anthropic();
const MODEL = 'claude-opus-4-7';
const FILES_BETA = 'files-api-2025-04-14';

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
