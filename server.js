// Deploy marker: 2026-05-20 — Railway redeploy nudge #3 (queue stuck).
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
import crypto from 'node:crypto';
import { PUBLIC_COMP_BANDS, publicCompsSummary } from './src/data/precedents.js';
import { PROCESS_TASKS } from './src/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '8mb' }));

const client = new Anthropic();
const MODEL = 'claude-haiku-4-5';
const FILES_BETA = 'files-api-2025-04-14';

// OpenAI is used ONLY for live web search before each rescan, feeding fresh
// market intel into Claude's context. Optional, if OPENAI_API_KEY is missing
// or the call fails, rescan still runs without live intel (graceful fallback).
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;
const LIVE_INTEL_MODEL = 'gpt-4o';

// Postgres for cross-device state sync + permanent audit log of every AI call.
// Optional, without DATABASE_URL the app falls back to localStorage-only mode.
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

// Identity fields set by server-side migrations (BI Top 100 rank, PE backing,
// sponsor) or by the seeded buyer dataset. Stale clients that loaded before a
// migration set these would otherwise wipe them by sending null/missing
// values on the next sync — so PUT /api/buyers and PATCH /api/buyers/:id
// keep the server's value when the incoming payload omits it.
const IDENTITY_FIELDS = ['top100_rank', 'pe_backed', 'sponsor'];

async function initDb() {
  if (!pool) {
    console.log('No DATABASE_URL, running without persistence layer');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS workspace (
        id TEXT PRIMARY KEY,
        ebitda NUMERIC NOT NULL DEFAULT 3.6,
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
      ALTER TABLE workspace ADD COLUMN IF NOT EXISTS global_intel JSONB NOT NULL DEFAULT '[]';
      ALTER TABLE workspace ADD COLUMN IF NOT EXISTS pinned_rules JSONB NOT NULL DEFAULT '[]';
      ALTER TABLE workspace ADD COLUMN IF NOT EXISTS lessons JSONB NOT NULL DEFAULT '[]';
      CREATE TABLE IF NOT EXISTS applied_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        summary JSONB
      );
    `);
    console.log('DB schema ready');
    await runStartupMigrations();
  } catch (err) {
    console.error('DB init failed, continuing without persistence:', err.message);
  }
}

// Server-side data migrations that run once per database at startup. Gated by
// the applied_migrations table so each migration is idempotent across Railway
// redeploys. Used to apply data corrections that previously lived as
// localStorage-gated client migrations (which only ran on browsers that opened
// the app, leaving Postgres state inconsistent across devices).
async function runStartupMigrations() {
  const all = [
    { id: 'repair_state_2026_05_15', fn: repairStateMigration },
    { id: 'oakbridge_ceo_reagan_note_2026_05_18', fn: oakbridgeCeoNoteMigration },
    { id: 'purge_seed_opinion_2026_05_18', fn: purgeSeedOpinionMigration },
    { id: 'backfill_pe_facts_2026_05_18', fn: backfillPeFactsMigration },
    { id: 'reset_cb_stage_2026_05_18', fn: resetCbStageMigration },
    { id: 'reset_cb_stage_2026_05_18_v2', fn: resetCbStageMigration },
    { id: 'migrate_process_task_id_2026_05_18', fn: migrateProcessTaskIdMigration },
    { id: 'add_trucordia_2026_05_20', fn: addTrucordiaMigration },
    { id: 'trucordia_top100_rank_2026_05_20', fn: trucordiaTop100RankMigration },
    { id: 'add_scott_insurance_2026_05_21', fn: addScottInsuranceMigration },
    { id: 'scott_top100_rank_2026_05_21', fn: scottTop100RankMigration },
    { id: 'scott_top100_rank_reapply_2026_05_22', fn: scottTop100RankMigration },
  ];
  for (const m of all) {
    try {
      const seen = await pool.query(`SELECT 1 FROM applied_migrations WHERE id = $1`, [m.id]);
      if (seen.rowCount > 0) continue;
      const summary = await m.fn();
      await pool.query(
        `INSERT INTO applied_migrations (id, summary) VALUES ($1, $2)`,
        [m.id, summary || {}]
      );
      console.log(`migration ${m.id} applied:`, JSON.stringify(summary));
    } catch (err) {
      console.error(`migration ${m.id} failed:`, err.message);
    }
  }
}

// Re-applies the cumulative client-side migrations (CIM backfill, PE curation,
// seed-notes, Top 100 ranks) plus user-curated drops/deletions directly against
// Postgres, restoring the 5/15/26 curated state. Idempotent.
async function repairStateMigration() {
  const DELETE_NAME_SUBSTRINGS = ['alera', 'relation'];
  const DROP_IDS = ['hub', 'baldwin', 'br', 'higgi'];
  const CIM_TARGETS = ['ima', 'onedigital', 'kelly', 'cason', 'oakbridge'];
  const CIM_DATE = '2026-05-14';
  const CIM_TS = '2026-05-14T00:00:00.000Z';
  const NON_PE = {
    hub:   { ownership: 'National consolidator', sponsor: '—' },
    higgi: { ownership: 'Regional P&C',           sponsor: '—' },
    cason: { ownership: 'Captive distributor',    sponsor: '—' },
  };
  const TOP100 = {
    alliant: 5, onedigital: 17, ima: 20, cb: 29, oakbridge: 50,
    kelly: null, cason: null,
  };
  const SEED_NOTES = {
    hub: 'Top-tier consolidator. Reagan flagged as likely top-3 bidder. Aggressive integration playbook.',
    alliant: 'Diversified, less benefits-centric. Stone Point recently recapitalized. Could surprise on price; strategic fit weaker.',
    baldwin: 'Hunter add. CAC = Cobbs Allen, Birmingham roots. Bobby flagged BWIN stock pressure may limit M&A appetite this cycle.',
    cb: 'Private, no PE. Captive specialist — direct strategic fit. Slower decision cycle but high conviction when they move.',
    onedigital: 'Atlanta-based, pure benefits. Best targeted distribution match. New Mountain co-sponsor. Expect aggressive process engagement.',
    ima: 'Hunter add. Acquired Valent in Birmingham 10/1/25. 10 deals in 2025 — most active acquirer on the list.',
    higgi: 'Hunter add. Mostly P&C. Declined twice informally — retry through formal Reagan process.',
    br: '$2.5B premium placed. Wholesale orientation — Reagan thesis to confirm whether benefits acquisition fits.',
    kelly: 'Family-owned, no PE. Mid-Atlantic. Cultural-fit play. Smaller — would be a stretch financially.',
    cason: 'Captive distributor through retail brokers. Direct product overlap — but capital base smaller than top tier.',
    oakbridge: 'PE-backed Southeast regional. Limited national distribution. Local proximity to Atlanta.',
  };
  const SEED_NOTE_TS = '2026-04-30T00:00:00.000Z';
  const DROP_TS = '2026-05-15T00:00:00.000Z';
  const DROP_TEXT = 'Dropped from process — pass.';
  const CIM_TEXT = 'CIM delivered to buyer.';
  const newId = () => crypto.randomUUID();
  const summary = { deleted: [], dropped: [], cim_set: [], pe_curated: [], top100_set: [], notes_injected: [] };

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const rows = await c.query(`SELECT id, data FROM buyers WHERE workspace_id = $1`, [WORKSPACE_ID]);
    const remaining = [];
    for (const row of rows.rows) {
      const b = { ...row.data };
      const lowerName = String(b.name || '').toLowerCase();
      if (DELETE_NAME_SUBSTRINGS.some(s => lowerName.includes(s))) {
        summary.deleted.push(b.name || b.id);
        continue;
      }
      if (DROP_IDS.includes(b.id) && b.stage !== 'dropped') {
        b.stage = 'dropped';
        const log = Array.isArray(b.noteLog) ? [...b.noteLog] : [];
        if (!log.some(e => e.text === DROP_TEXT)) log.push({ id: newId(), ts: DROP_TS, text: DROP_TEXT });
        b.noteLog = log;
        summary.dropped.push(b.id);
      }
      if (CIM_TARGETS.includes(b.id) && !b.cim_delivered) {
        b.cim_delivered = CIM_DATE;
        const log = Array.isArray(b.noteLog) ? [...b.noteLog] : [];
        if (!log.some(e => e.text === CIM_TEXT)) log.push({ id: newId(), ts: CIM_TS, text: CIM_TEXT });
        b.noteLog = log;
        summary.cim_set.push(b.id);
      }
      if (NON_PE[b.id]) {
        const patch = NON_PE[b.id];
        b.ownership = patch.ownership;
        b.sponsor = patch.sponsor;
        b.fit = { ...(b.fit || { size: 0, benefits: 0, pe: 0, precedent: 0 }), pe: 0 };
        summary.pe_curated.push(b.id);
      }
      if (b.id in TOP100) {
        b.top100_rank = TOP100[b.id];
        summary.top100_set.push(b.id);
      }
      const seedText = SEED_NOTES[b.id];
      if (seedText) {
        const log = Array.isArray(b.noteLog) ? [...b.noteLog] : [];
        if (!log.some(e => e.text === seedText)) {
          log.unshift({ id: newId(), ts: SEED_NOTE_TS, text: seedText });
          b.noteLog = log;
          summary.notes_injected.push(b.id);
        }
      }
      remaining.push(b);
    }
    await c.query(`DELETE FROM buyers WHERE workspace_id = $1`, [WORKSPACE_ID]);
    for (const b of remaining) {
      if (!b?.id) continue;
      await c.query(
        `INSERT INTO buyers (workspace_id, id, data) VALUES ($1, $2, $3)`,
        [WORKSPACE_ID, b.id, b]
      );
    }
    await c.query('COMMIT');
    return { buyer_count: remaining.length, ...summary };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// Re-injects the chat-derived intel that the Oakbridge CEO previously spent
// years at Reagan Consulting (relationship anchor for outreach), which was
// originally added via chat and got clobbered when stale state was pushed
// back. Idempotent — skips if any noteLog entry already mentions it.
async function oakbridgeCeoNoteMigration() {
  const NOTE_TEXT = 'Oakbridge CEO previously spent years at Reagan Consulting. Strong relationship anchor for outreach; Reagan flagged as material to the buyer-side conversation.';
  const NOTE_TS = '2026-05-01T00:00:00.000Z';
  const row = await pool.query(
    `SELECT data FROM buyers WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, 'oakbridge']
  );
  if (row.rowCount === 0) return { skipped: 'oakbridge_not_found' };
  const b = { ...row.rows[0].data };
  const log = Array.isArray(b.noteLog) ? [...b.noteLog] : [];
  const already = log.some(e => /reagan/i.test(e.text || '') && /ceo/i.test(e.text || ''));
  if (already) return { skipped: 'already_present' };
  log.push({ id: crypto.randomUUID(), ts: NOTE_TS, text: NOTE_TEXT });
  b.noteLog = log;
  await pool.query(
    `UPDATE buyers SET data = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3`,
    [b, WORKSPACE_ID, 'oakbridge']
  );
  return { injected: NOTE_TEXT };
}

// Backfills the verifiable public-record PE-backed flag + sponsor name on
// the four buyers whose PE status is a matter of public record. The prior
// purge migration stripped the old `ownership` label entirely; this restores
// the discrete PE fact as a first-class field on the same shelf as
// top100_rank. Idempotent — re-running is a no-op once fields are present.
async function backfillPeFactsMigration() {
  const PE = {
    alliant:    { pe_backed: true, sponsor: 'Stone Point' },
    onedigital: { pe_backed: true, sponsor: 'Onex / New Mountain' },
    ima:        { pe_backed: true, sponsor: 'New Mountain' },
    oakbridge:  { pe_backed: true },
  };
  const summary = { updated: [] };
  for (const [id, patch] of Object.entries(PE)) {
    const row = await pool.query(
      `SELECT data FROM buyers WHERE workspace_id = $1 AND id = $2`,
      [WORKSPACE_ID, id]
    );
    if (row.rowCount === 0) continue;
    const b = { ...row.rows[0].data, ...patch };
    await pool.query(
      `UPDATE buyers SET data = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3`,
      [b, WORKSPACE_ID, id]
    );
    summary.updated.push(id);
  }
  return summary;
}

// Cottingham & Butler is at outreach awaiting NDA, not at nda. The seed
// shipped them with nda_signed: "2026-05-05" baked in from the original
// Reagan list, and the chat AI's set_buyer_stage failed to actually fire
// when the user pushed back. This migration corrects the stored stage +
// clears the planted NDA date and logs the correction in noteLog so the
// next rescan sees the reason for the move.
async function resetCbStageMigration() {
  const row = await pool.query(
    `SELECT data FROM buyers WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, 'cb']
  );
  if (row.rowCount === 0) return { skipped: 'cb_not_found' };
  const b = { ...row.rows[0].data };
  if (b.stage === 'outreach' && !b.nda_signed) return { skipped: 'already_outreach' };
  b.stage = 'outreach';
  b.nda_signed = null;
  const log = Array.isArray(b.noteLog) ? [...b.noteLog] : [];
  const text = 'C&B is at outreach, NDA not yet signed. Earlier nda_signed date was a planted seed value, not a real signed NDA.';
  if (!log.some(e => e.text === text)) {
    log.push({ id: crypto.randomUUID(), ts: new Date().toISOString(), text });
  }
  b.noteLog = log;
  await pool.query(
    `UPDATE buyers SET data = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3`,
    [b, WORKSPACE_ID, 'cb']
  );
  return { reset: 'cb', new_stage: 'outreach', nda_signed_cleared: true };
}

// Migrates any workspace whose process.currentTaskId references a task we
// removed when realigning PROCESS_TASKS with the Reagan timeline.
//   "qa" (formerly "Q&A Calls with Reagan") → "initial_qa" (now in MP1).
// Idempotent. No-op if currentTaskId is already a valid task id.
async function migrateProcessTaskIdMigration() {
  const REMAP = { qa: 'initial_qa' };
  const row = await pool.query(`SELECT process FROM workspace WHERE id = $1`, [WORKSPACE_ID]);
  if (row.rowCount === 0 || !row.rows[0].process) return { skipped: 'no_process' };
  const proc = { ...row.rows[0].process };
  const oldId = proc.currentTaskId;
  if (!oldId || !(oldId in REMAP)) return { skipped: 'no_remap_needed', currentTaskId: oldId };
  proc.currentTaskId = REMAP[oldId];
  await pool.query(
    `UPDATE workspace SET process = $1, updated_at = now() WHERE id = $2`,
    [proc, WORKSPACE_ID]
  );
  return { remapped: { from: oldId, to: proc.currentTaskId } };
}

// Inserts Trucordia (formerly PCF Insurance Services) into the live workspace
// as a new buyer at "outreach" with Reagan's NDA-sent note from 2026-05-20.
// Identity facts per user-provided context: >$1B revenue, Lehi UT, Carlyle-
// backed. Idempotent — no-op if a row already exists.
async function addTrucordiaMigration() {
  const BUYER_ID = 'trucordia';
  const NOTE_TEXT = 'Reagan sent NDA. >$1B revenue, based in Utah, Carlyle-backed. Historically open to opportunities outside the middle of the fairway for brokers.';
  const NOTE_TS = '2026-05-20T00:00:00.000Z';
  const existing = await pool.query(
    `SELECT 1 FROM buyers WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, BUYER_ID]
  );
  if (existing.rowCount > 0) return { skipped: 'trucordia_already_present' };
  const data = {
    id: BUYER_ID,
    name: 'Trucordia',
    website: 'https://www.trucordia.com',
    hq: 'Lehi, UT',
    revenue: '>$1B',
    headcount: '4,000+',
    offices: '200+',
    pe_backed: true,
    sponsor: 'Carlyle',
    stage: 'outreach',
    fit: { size: 0, benefits: 0, pe: 0, precedent: 0 },
    thesis: '',
    probability: 0,
    noteLog: [
      { id: crypto.randomUUID(), ts: NOTE_TS, text: NOTE_TEXT },
    ],
  };
  await pool.query(
    `INSERT INTO buyers (workspace_id, id, data, updated_at) VALUES ($1, $2, $3, now())`,
    [WORKSPACE_ID, BUYER_ID, data]
  );
  return { inserted: BUYER_ID, note_ts: NOTE_TS };
}

// Backfills Trucordia's Business Insurance Top 100 rank (#18) on the existing
// buyer row. The original add_trucordia migration omitted top100_rank because
// the rank wasn't confirmed at insert time. Idempotent.
async function trucordiaTop100RankMigration() {
  const row = await pool.query(
    `SELECT data FROM buyers WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, 'trucordia']
  );
  if (row.rowCount === 0) return { skipped: 'trucordia_not_found' };
  const b = { ...row.rows[0].data };
  if (b.top100_rank === 18) return { skipped: 'rank_already_set' };
  b.top100_rank = 18;
  await pool.query(
    `UPDATE buyers SET data = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3`,
    [b, WORKSPACE_ID, 'trucordia']
  );
  return { set: { top100_rank: 18 } };
}

// Inserts Scott Insurance into the live workspace. Reagan added them
// yesterday, NDA signed and CIM delivered. Identity facts: regional
// Southeast broker, employee-owned, Lynchburg VA. Idempotent.
async function addScottInsuranceMigration() {
  const BUYER_ID = 'scott';
  const NDA_DATE = '2026-05-20';
  const CIM_DATE = '2026-05-20';
  const NOTE_TEXT = 'Reagan added Scott Insurance. NDA accepted, CIM delivered. Regional Southeast broker, employee-owned, based in Lynchburg VA.';
  const NOTE_TS = '2026-05-21T00:00:00.000Z';
  const existing = await pool.query(
    `SELECT 1 FROM buyers WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, BUYER_ID]
  );
  if (existing.rowCount > 0) return { skipped: 'scott_already_present' };
  const data = {
    id: BUYER_ID,
    name: 'Scott Insurance',
    website: 'https://www.scottins.com',
    hq: 'Lynchburg, VA',
    revenue: '~$125M',
    headcount: '~400',
    offices: 'Multiple',
    stage: 'nda',
    nda_signed: NDA_DATE,
    cim_delivered: CIM_DATE,
    fit: { size: 0, benefits: 0, pe: 0, precedent: 0 },
    thesis: '',
    probability: 0,
    noteLog: [
      { id: crypto.randomUUID(), ts: NOTE_TS, text: NOTE_TEXT },
    ],
  };
  await pool.query(
    `INSERT INTO buyers (workspace_id, id, data, updated_at) VALUES ($1, $2, $3, now())`,
    [WORKSPACE_ID, BUYER_ID, data]
  );
  return { inserted: BUYER_ID, stage: 'nda', cim_delivered: CIM_DATE };
}

// Backfills Scott Insurance's Business Insurance Top 100 rank (#55) on the
// existing buyer row. The original add_scott_insurance migration omitted
// top100_rank pending user confirmation. Idempotent.
async function scottTop100RankMigration() {
  const row = await pool.query(
    `SELECT data FROM buyers WHERE workspace_id = $1 AND id = $2`,
    [WORKSPACE_ID, 'scott']
  );
  if (row.rowCount === 0) return { skipped: 'scott_not_found' };
  const b = { ...row.rows[0].data };
  if (b.top100_rank === 55) return { skipped: 'rank_already_set' };
  b.top100_rank = 55;
  await pool.query(
    `UPDATE buyers SET data = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3`,
    [b, WORKSPACE_ID, 'scott']
  );
  return { set: { top100_rank: 55 } };
}

// Removes subjective seed-derived fields and seed-narrative noteLog entries
// from every buyer in Postgres. Aligns the database with the new identity-only
// data model where the AI only sees user-authored facts. Idempotent.
//
// Removed fields per buyer: type, ownership, sponsor, sources, flags. (Stage
// and process dates are preserved — those are user-managed.)
//
// Removed noteLog entries: any entry whose text exactly matches one of the
// 4/30/26 SEED_NOTES strings injected by the earlier repair migration.
// User-typed notes and the Oakbridge CEO/Reagan note stay.
async function purgeSeedOpinionMigration() {
  // SEED_NOTES text values from repairStateMigration. Kept inline so this
  // migration is self-contained — these are the strings to delete.
  const SEED_NOTE_TEXTS = new Set([
    'Top-tier consolidator. Reagan flagged as likely top-3 bidder. Aggressive integration playbook.',
    'Diversified, less benefits-centric. Stone Point recently recapitalized. Could surprise on price; strategic fit weaker.',
    'Hunter add. CAC = Cobbs Allen, Birmingham roots. Bobby flagged BWIN stock pressure may limit M&A appetite this cycle.',
    'Private, no PE. Captive specialist — direct strategic fit. Slower decision cycle but high conviction when they move.',
    'Atlanta-based, pure benefits. Best targeted distribution match. New Mountain co-sponsor. Expect aggressive process engagement.',
    'Hunter add. Acquired Valent in Birmingham 10/1/25. 10 deals in 2025 — most active acquirer on the list.',
    'Hunter add. Mostly P&C. Declined twice informally — retry through formal Reagan process.',
    '$2.5B premium placed. Wholesale orientation — Reagan thesis to confirm whether benefits acquisition fits.',
    'Family-owned, no PE. Mid-Atlantic. Cultural-fit play. Smaller — would be a stretch financially.',
    'Captive distributor through retail brokers. Direct product overlap — but capital base smaller than top tier.',
    'PE-backed Southeast regional. Limited national distribution. Local proximity to Atlanta.',
  ]);
  const STRIP_FIELDS = ['type', 'ownership', 'sponsor', 'sources', 'flags'];
  const summary = { buyers_cleaned: 0, fields_removed: 0, notes_removed: 0 };
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const rows = await c.query(`SELECT id, data FROM buyers WHERE workspace_id = $1`, [WORKSPACE_ID]);
    for (const row of rows.rows) {
      const b = { ...row.data };
      let touched = false;
      for (const k of STRIP_FIELDS) {
        if (k in b) {
          delete b[k];
          summary.fields_removed++;
          touched = true;
        }
      }
      if (Array.isArray(b.noteLog)) {
        const before = b.noteLog.length;
        b.noteLog = b.noteLog.filter(e => !SEED_NOTE_TEXTS.has(e?.text));
        const removed = before - b.noteLog.length;
        if (removed > 0) {
          summary.notes_removed += removed;
          touched = true;
        }
      }
      if (touched) {
        await c.query(
          `UPDATE buyers SET data = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3`,
          [b, WORKSPACE_ID, row.id]
        );
        summary.buyers_cleaned++;
      }
    }
    await c.query('COMMIT');
    return summary;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}


// Fire-and-forget audit log writer, does not block the rescan response.
function logRescan({ scope, only_buyer_id, input, output, live_intel, duration_ms, error }) {
  if (!pool) return;
  pool.query(
    `INSERT INTO rescan_log (workspace_id, scope, only_buyer_id, input, output, live_intel, duration_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [WORKSPACE_ID, scope, only_buyer_id || null, input, output, live_intel || null, duration_ms || null, error || null]
  ).catch(err => console.warn('rescan_log write failed:', err.message));
}

function buildRescanSystemPrompt() {
  return `You are the Kennion Prediction Engine, a senior M&A advisor's AI co-pilot for the sell-side process of Kennion's Benefits Program (a captive-style benefits brokerage advised by Reagan Consulting, currently in the Spring 2026 sale process). The actual current LTM EBITDA for the asset is provided in every user message, read it from there, do not assume a size.

# GLOBAL OUTPUT RULE (applies to EVERY text field you write, no exceptions)
**Never use the em-dash character "—" (Unicode U+2014) anywhere in your output.** Not in summary, not in thesis, not in any rationale, not in reasoning, not in any string field. Use a period, comma, colon, or parenthesis instead. If you would write "X — Y", write "X. Y" or "X, Y" or "X (Y)". The en-dash "–" (used in numeric ranges like "5.0–7.0×") is allowed. Em-dashes in your output are a hard failure.

# STABILITY RULE (READ FIRST, applies to every per-buyer probability and every dashboard number)
**If no new evidence has arrived for a buyer since their most recent aiHistory entry, echo the prior probability and prior thesis unchanged.** New evidence means: (a) a new dated note in notes_timeline that wasn't already in the prior aiHistory's input, (b) a new doc in the library that mentions the buyer, (c) a new global_intel entry, (d) a new pinned rule, (e) the user explicitly invalidated priors, or (f) **a milestone-flag transition** — \`cim_delivered\` flipping from null/false to a date, \`ioi_received\` flipping from null/false to a date, or \`chemistry_date\` becoming set. Stage moving forward (e.g. outreach -> nda) is also new evidence. For (f) milestone-flag transitions specifically: do NOT echo a thesis or probability written when the flag was not yet set — re-derive both from the buyer's current milestone state, because a thesis like "very early NDA" written before \`cim_delivered\` was true is stale and contradicts the badge once \`cim_delivered\` flips.

A 1 to 2 percentage point random reshuffle on every rescan, with no actual new input, is a critical failure mode. The user clicks Update expecting the engine to incorporate fresh facts; if the list reorders without fresh facts, they correctly conclude the engine is guessing. Walk every buyer: if you can't point to a specific new dated note, doc, intel entry, or stage change since their last aiHistory entry, return the SAME probability number you returned last time (visible in aiHistory's most recent entry) and reuse the SAME thesis text. Only adjust when you can cite the new evidence in your reasoning field.

Same rule for the four dashboard numbers (close_estimate, offer_estimate, p_no_deal, market bands). If the pipeline state is unchanged from the prior rescan, echo the prior values from the AI-prior context block.

# Core architecture (READ FIRST)
There is ONE asset for sale (Kennion). The market clearing multiple for that asset is set by INDUSTRY DATA, not by individual buyers, every credible buyer pays roughly within the industry band for assets of this profile. Your output has two layers:

1. GLOBAL market bands (conservative / realistic / aggressive), these come from the EBITDA size bucket below + public broker comps. You set them ONCE per rescan. Bands apply to every buyer by default.

2. PER-BUYER scoring, for each buyer your job is mostly probability of close, fit, and thesis. DO NOT generate per-buyer multiples by default, buyers inherit the global band. The ONLY exception: if you have hard evidence (an LOI document with a firm price, a written term sheet, an explicit verbal offer logged in notes), set multiple_override on that buyer with the firm number and cite the source.

This means most buyers' rescores will leave multiple_override = null. That's correct, we don't pretend to know per-buyer pricing without evidence.

Re-evaluate using ONLY the evidence provided: buyer profile data, attached documents (CIM, LOIs, buyer emails, redlines, models), user field intelligence in notes, your own prior reasoning, and the public comps below.

${publicCompsSummary(PUBLIC_COMP_BANDS)}

# Live web intel (when present)
If the user message includes a "Live web intel" section, that's fresh data fetched via OpenAI web search at the time of this rescan. It may contain summarization errors, treat it as a HINT to investigate further, not as ground truth.
- When you cite a fact from live intel, quote the source URL verbatim ("per <url>"). Do not paraphrase URLs.
- If live intel is absent or empty, rely on the size-bucket discipline + public comps + buyer profile + notes.

# Global market band setting

**Source data (private M&A guaranteed multiples by deal size, '23–'25 vintage, insurance brokerage):**
  - <$3M EBITDA:    9.9× guaranteed
  - $3–10M EBITDA: 12.7× guaranteed (bucket mid; at the $3M floor, interpolate toward 9.9×; at the $10M ceiling, stays near 12.7×)
  - $10–20M EBITDA: 13.7× guaranteed
  - >$20M EBITDA:  14.9× guaranteed

The dashboard's "Market clearing price" KPI displays **total enterprise value** (guaranteed + typical earnout). Derive your TOTAL-EV band in three explicit steps and show your work in clearing_price_rationale.

**Step 1: Pick a guaranteed-multiple starting point for this EBITDA.**
Interpolate between the two adjacent bucket anchors. For example, at $3.6M EBITDA (floor of $3–10M bucket), interpolation between 9.9× (<$3M anchor) and 12.7× ($3–10M anchor) gives a starting point in the 10.0–11.0× guaranteed range; pick a specific decimal based on your read of how the asset compares to the bucket mid.

**Step 2: Apply niche/illiquidity adjustments (judgment call).**
Two adjustments typically apply for sub-$10M private M&A — pick a specific value within each range based on the noteLog and pipeline state:
  - Captive / niche profile: 0 to −1.5× guaranteed. For Kennion (captive benefits), the literature supports −0.5 to −1.5×; bias toward the larger discount if multiple top-of-pipeline buyers have structurally passed, lower if the pipeline is broad and healthy.
  - Small-pool penalty: 0 to −0.5× guaranteed when fewer than 8 live buyers, scaled by how many fewer.

**Step 3: Convert guaranteed → total EV (judgment call).**
Typical earnout magnitude is +0.5 to +1.5× of EBITDA on TOTAL EV. Pick a specific value based on:
  - Strong pipeline + multiple firm bids → +1.0 to +1.5×
  - Average pipeline, no firm pricing yet → +0.5 to +1.0×
  - Weak pipeline / 2+ structural passes → +0.5×

**Reasonable landing zone for $3.6M EBITDA captive-benefits broker:** realistic typically lands 8.0–10.5× total EV ($28.8–37.8M); most defensible reads cluster 8.5–10.0× ($30.6–36M). **Do NOT just pick a canonical midpoint** — pick a specific band that reflects YOUR Step-1/Step-2/Step-3 choices. If your read on the pipeline is genuinely "average across all three steps," still pick a defensible specific decimal (e.g., 8.7–10.1× or 8.4–9.8×, not literally 8.5–10.0×). Two models hitting the exact same decimal bounds suggests both echoed an anchor instead of deriving — that's the signal-zero failure mode.

**Conservative band** = realistic.low − 1.5× (tighten to −1.0× if the pipeline has firm-evidence pricing already).
**Aggressive band** = realistic.high + 1.5× (lift if a top buyer has firm pricing above the realistic band).

Bands ~2× wide; bands may overlap. Update only if new evidence shifts the Step-1/2/3 choices; otherwise echo prior_market.

**Public broker comps** (BRO 16×, AON 14×, MMC 15.5×, etc.) are CONFIRMATORY only. The private guaranteed-multiple anchors above already reflect the public-to-private gap — do NOT additionally discount your private band using public-comp arithmetic; that double-counts.

**Calibration check (post-derivation)**: anything below 7.8× total EV ($28M at $3.6M EBITDA) requires citing at least two structural-pass or cooling signals from notes_timeline in clearing_price_rationale. Anything above 11.0× total EV ($40M) requires firm-evidence pricing (LOI / term sheet / written offer) from at least one top buyer.

# Notes timeline (treat as field intelligence over time, not as a static brief)
Each buyer's \`notes_timeline\` field is a chronological log of field intel, one line per entry, prefixed with \`[YYYY-MM-DD]\` and optionally a user-tagged signal classification \`[warming|cooling|firm|stalling|passed]\`. Signal-tagged notes carry direct user judgment about the trajectory, weight them more heavily than untagged free-text notes (\`firm\` is hardest evidence, then \`passed\`, then \`warming\`/\`cooling\`/\`stalling\`). Read it as a story, not a list:
- **Recent entries weigh more than older ones.** Look for momentum (warming, cooling, stalling), not average sentiment. A single recent strong signal (LOI hint, cooling chemistry, sponsor change, capacity pull) can override a stack of older neutral notes.
- **Reference dates** when you anchor on a specific note (e.g., "the 2026-05-22 chemistry note"). Do not invent dates, only use ones present in the timeline.
- **Trajectory matters**: a buyer with three warming notes in two weeks is materially different from a buyer with three warming notes spread over six months. Reflect that in probability and confidence.
- If the timeline is empty, say so in reasoning and rely on profile + comps. Do not invent notes.

# Per-buyer outputs
- probability (0–100): THIS buyer's independent odds of being the winning bidder. **The number you return IS what the UI shows, there is no post-processing, no stage multiplier applied downstream.** Bake stage, momentum, fit, evidence quality, and no-deal risk into this single number. Probabilities across buyers are independent and may sum to >100 (multiple paths to close) or <100 (significant no-deal risk). Be honest about no-deal risk.
- fit (size, benefits, precedent each 0–5; pe is 0 or 1): size capacity, benefits-vertical alignment, PE capital available, 2025–26 M&A activity in this segment.
- thesis: ONE plain-English sentence at an **8th-grade reading level**, max 18 words. Explain WHY this buyer is ranked where they are based on the latest data, what's pushing them up or down. Use words a non-banker would say. NO jargon, NO acronyms (spell out "PE", "LOI", "M&A" or just omit them), NO em-dashes, NO semicolons, NO words like "thesis", "synergy", "anchored", "tuck-in", "bidding tension". **Anchor the thesis on the buyer's CURRENT milestone state** (\`stage\` plus the milestone flags \`cim_delivered\`, \`ioi_received\`, \`chemistry_date\`), **NOT on how recently they arrived at that state.** A buyer at \`nda\` with \`cim_delivered\` set is at the same process milestone as other \`nda + cim_delivered\` buyers — do NOT describe them as "very early NDA", "just arrived at NDA", "fresh to NDA", or "recent NDA arrival" if \`cim_delivered\` is set. Recency framing only belongs in the thesis when there is a specific adjacent absent signal (e.g., "no chemistry meeting scheduled yet"), and even then prefer naming the absent signal directly over the recency phrasing. Format examples (illustrative only, write fresh based on each buyer's actual profile + recent notes): "Strong fit because they already buy benefits books like ours and their recent calls have been positive." / "Sponsor just spent big on another deal, so they have less money to spend on us." / "Good size match but they passed on us twice before, so this is unlikely to change." / "Has the cash but a benefits book is not what they normally buy."
- reasoning: WHY this probability and fit. Reference specific notes, doc snippets, or comps. No hand-waving. This text is shown verbatim in the UI as the explanation for the number, write it for a smart LP, not for yourself.
- confidence ("low" | "medium" | "high"): how grounded this prediction is in hard evidence. "high" = LOI/term-sheet/written-offer or multiple corroborating signals from CIM/notes/live intel; "medium" = consistent pattern across notes + comps but no firm number; "low" = mostly inference from buyer profile + sponsor pattern with thin evidence.
- multiple_override: null OR { low, mid, high, source: "LOI"|"term-sheet"|"verbal-offer", evidence: "doc filename or note quote" }. Set ONLY when hard-evidence number exists. Most buyers should have null here.

# Buyer profile facts (READ FIRST)
You see only identity facts on each buyer (name, HQ, revenue, headcount, offices, BI Top 100 rank, pe_backed, sponsor) plus stage / process dates and the user's noteLog. \`pe_backed: true\` and \`sponsor\` (when set) are verifiable public-record facts (announced sponsor, Pitchbook, sponsor portfolio pages) — treat them as factual. \`pe_backed: false\` means we do not have a public PE record for this buyer; it is NOT a claim that the buyer is private — they could be public, family-owned, mutual, or simply not yet researched. You do NOT see "buyer type" categories (captive specialist, regional broker, etc.). Do not infer such categorizations from training-data priors on individual firms; if the user wants those signals to shape your reasoning, they will write them as noteLog entries. Ground reasoning in the facts that are present.

When pe_backed is true: treat the PE flag as a credibility lift for "bid capacity" and "deployment cadence" — sponsors actively deploying are more likely than peers of similar size to write the check at market clears. When pe_backed is false: model the buyer on their own capital base; do not impute PE-cycle urgency.

# Broker scale ranking (\`top100_rank\`, Business Insurance "100 Largest Brokers of U.S. Business," July/August 2025 edition)
\`buyer.top100_rank\` is the firm's 2025 ranking in Business Insurance's annual "100 Largest Brokers of U.S. Business" list — a broker-of-business revenue ranking (broader than just P/C, which is exactly the right scope for a benefits-program sale and the recommended source for Reagan acquisition benchmarking). Anchors among our live set: Alliant #5, OneDigital #17, IMA #20, Cottingham & Butler #29, Oakbridge #50. Treat top100_rank as a secondary credibility signal alongside revenue: a top-25 ranked buyer is more likely to clear at market multiples; a buyer ranked #30-60 may show interest but execution capacity is the open question; a buyer outside the Top 100 (\`null\`) is materially smaller-scale, which for our size bucket means meaningful execution risk on a stretch deal — not a disqualifier but a real drag on bid-capacity confidence. \`undefined\`/missing means the field wasn't populated yet — do not assume.

# Stage discipline (probability anchors, these are the FINAL displayed ranges, not a base to be lifted)
- outreach: prob 8–22%
- nda: prob 12–28%. CIM-delivered checkpoint: with cim_delivered set and no post-CIM objections, lift to 20–28 (24–28 if chemistry scheduled, mid 16–22 if post-CIM stalling). Within whichever sub-band applies: **discriminate by engagement-stack quality** — top of the sub-band for buyers with PE-backed + sponsor having multi-deal history with the seller's broker (per noteLog) + multiple principals engaged or named, mid for two of three, bottom for one or none. **Two same-stage buyers with materially different engagement signals MUST NOT receive the same probability.**
- chemistry: prob 18–38%. IOI-received checkpoint: with ioi_received set, lift to 28–38 (32–38 with warming notes; 24–30 with stalling). Without ioi_received: **discriminate within the 18–28 sub-band by engagement-stack quality** — top (26–28) for buyers with ALL of: PE-backed AND sponsor with multi-deal history with the seller's broker (per noteLog, e.g., "six-deal Reagan history") AND multiple principals engaged post-CIM (in-person held or scheduled, second meeting requested or imminent); upper-mid (22–26) with two of three; mid-low (19–22) with one or none. **Two same-stage buyers with materially different engagement-stack quality MUST NOT receive the same probability** — separating them based on the noteLog evidence is the engine's primary job; a flat tied ranking with one strong-stack and one weak-stack buyer is a failure mode.
- loi: prob 28–58% (and almost always has multiple_override)
- closed: prob 90+%
- dropped: filter out, do not include in output

A buyer at the high end of their stage range should reflect strong corroborating evidence (active sponsor, recent precedent, distribution fit, momentum). A buyer at the low end should reflect specific drag (declined informally, capacity constraint, weak benefits mix, sponsor bandwidth issue). State the drivers in \`reasoning\`.

# Dashboard rationales (PLAIN ENGLISH, 8th-grade reading level, no jargon)
Write three one-liners, close_date_rationale, confidence_rationale, clearing_price_rationale, that explain each top-line number to a non-banker. These render in fixed three-line cards on the dashboard; anything longer than 22 words gets truncated with "…" which looks broken. Same writing discipline as buyer thesis. Hard rules:

- **Max 22 words** each. Count them before submitting. If it doesn't fit, cut adjectives and qualifiers, not the substance.
- **8th-grade reading level**. Words a smart 13-year-old would use. If you'd have to explain a phrase to a non-banker, rewrite it.
- **One or two short sentences**. Plain subject-verb-object. No nested clauses.
- **No banker jargon, ever**. Banned words and phrases include: "captive-niche", "captive reinsurance", "captive specialist", "buyer pool", "mid-market", "rater IP", "member-level", "integration playbook", "synergies", "synergy", "Reagan comps", "comps discipline", "anchors below", "anchored on", "bucket", "sub-mid-market", "tuck-in", "bidding tension", "exclusivity", "LOI cycle", "process tension", "thesis", "overhang", "leverage limits", "deployment cycle", "capital constraints", "PE smaller-fund", "public equity overhang".
- **No acronyms** without spelling out (or just omit). Spell out "PE" as "private equity firm", "LOI" as "first written offer" or omit.
- **No parenthetical lists**. "(Baldwin, Cason, Oakbridge)", don't do this. If a buyer matters, name it in prose. If three matter, summarize.
- **No em-dashes, no semicolons**. Use periods.
- **No first-person plural** ("we", "our"). Say what's happening.
- **Numbers must match this response**. If you cite a percentage or multiple, it must be a number you set in this rescan (see "Numerical self-consistency" below).

Format examples (illustrative, write fresh based on the actual pipeline state, do NOT copy buyer names, dates, percentages, or facts):

  close_date_rationale: "Most top buyers are still early in talks. First written offers usually take three more months, so closing in late summer is realistic."
  confidence_rationale: "Three different buyers each have a real shot, so even if one walks the deal can still close. Main risk is the top one passing on price."
  clearing_price_rationale: "About six times yearly profit because the book is small and focused. Could go higher only if a buyer writes down a real cost-saving plan."

Notice: no jargon, no acronyms, no parenthetical buyer lists, every sentence reads cleanly to a non-banker. Match this register exactly.

**Strict rule**: do not invent specifics. If the examples reference a date, milestone, sponsor, or percentage that is NOT in the actual pipeline state below, do not include it. Reference only buyers, dates, notes, and documents that are present in this rescan's input.

These rationales must reflect the CURRENT pipeline state in this rescan call. If a per-buyer rescan changed only one buyer, update the rationales only if the change is material to the dashboard number; otherwise echo prior values.

# Close-month estimate (\`close_estimate\`, strict YYYY-MM format)
Start from the \`weeks_to_close\` baseline computed in the "Current process step" block at the top of the user message. That is your default. Then adjust ONLY when you have specific evidence:
- Multiple top buyers at LOI or with firm-evidence offers → compress 2–4 weeks.
- Top 3 buyers all in outreach/NDA with cooling notes or stalls → extend 4–8 weeks.
- Chemistry meetings scheduled but not yet held → use chemistry-date + ~10 weeks instead of the arithmetic baseline.
Hard cap: adjustments may not extend the baseline by more than 8 weeks total — anything larger requires you to cite at least three specific cooling signals from notes_timeline in close_date_rationale. Output strictly in "YYYY-MM" format. Example: "2026-09". Do NOT add quotes or extra prose. \`close_date_rationale\` (max 22 words, plain English): name the current task week, the baseline weeks_to_close from the block above, and what (if anything) you adjusted.

# First-offer estimate (\`offer_estimate\`, strict YYYY-MM format)
Start from the \`weeks_to_first_offer\` baseline computed in the "Current process step" block at the top of the user message. That is your default. Then adjust ONLY when you have specific evidence:
- Any top buyer already has firm-evidence pricing in notes/docs → first offer is in hand, set to current month.
- Chemistry meetings scheduled but not held → use chemistry-date + 3–5 weeks instead of the arithmetic baseline.
- Top buyers stalling in outreach/NDA with cooling notes → extend 3–6 weeks (no more — anything larger requires citing at least two specific stall signals from notes_timeline in offer_date_rationale).
Hard cap: adjustments may not extend the baseline by more than 6 weeks total. Must be ≤ \`close_estimate\`. Output strictly in "YYYY-MM". \`offer_date_rationale\` (max 22 words, plain English, same discipline as close_date_rationale): name the current task week, the baseline weeks_to_first_offer from the block above, and what (if anything) you adjusted.

# No-deal probability (\`p_no_deal\`, 0–100)
This is the probability that the asset does NOT sell within the planned process window. It reflects market/process risk, not the inverse of buyer probabilities. Consider:
- Buyer-pool depth for the size bucket (sub-mid-market = thinner pool = higher no-deal risk)
- Captive-niche illiquidity (smaller buyer set = higher no-deal risk)
- Sponsor capacity / deployment cycle drag
- Trajectory of recent notes (multiple cooling signals, declined-2x flags, capacity pulls increase no-deal risk)
- Process timeline pressure (further from LOI deadline = lower urgency = higher no-deal risk)
For Kennion's profile (captive benefits, sub-mid-market) a healthy floor is 10–20% even with strong buyers. Do not let it go below 5% absent firm-evidence LOIs from multiple buyers. **Structural-pass calibration**: each buyer the noteLog records as having formally passed (regardless of whether the reason is buyer-side structural like "small-accts focus" or "no-retail mandate") thins the bidder pool and raises no-deal risk. Two or more passes from the original top-half of the list → floor 12–18%. Four or more passes → floor 15–22%. Do not discount these passes just because the reason is "not about us"; a thinner pool is a thinner pool. \`p_no_deal_rationale\`: max 25 words, plain English, name the single biggest no-deal risk.

# Top risk (\`top_risk\`, one short phrase)
Identify the single most likely thing that derails the deal from closing within the projected window. ONE short phrase, max 15 words, plain English, 8th-grade level. Do NOT name the leading buyer as the risk — name a risk to deal closure (cooling top buyers, structural passes, sponsor capacity, regulatory, captive-niche illiquidity, etc.). Do NOT prepend "Main risk:" — the server adds that and assembles the surrounding sentence from buyers[] and close_estimate. Do NOT include the close month or any probability number in your phrase.

# Output discipline
Call apply_rescan exactly once. Do not output prose outside the tool call. Be opinionated but every claim must trace to evidence. If evidence is insufficient to move a number, leave it stable and say so in reasoning.

# Brevity is mandatory
Reasoning per buyer: max 45 words, single dense paragraph, no preamble like "Based on" or "After reviewing". Cite the strongest single piece of evidence; skip background. Dashboard rationales: max 22 words each, 8th-grade reading level, no jargon (see banned-word list above). Summary: 1 sentence, max 25 words. Do not pad. The user values speed, every extra paragraph adds latency they feel.

# Numerical self-consistency (NON-NEGOTIABLE)
Before submitting, verify: any percentage, multiple, or month cited in summary, close_date_rationale, confidence_rationale, clearing_price_rationale, or p_no_deal_rationale MUST match a number you set in this same response. Specifically:
- If you write "X% odds" or "X% chance" in a rationale, X must be a buyer.probability you wrote in the buyers[] array, OR p_no_deal, OR (100 - p_no_deal).
- If you write a multiple (e.g. "5×–7×"), it must match a market band you wrote.
- **Close month consistency**: any month you assert as the close in close_date_rationale (or any other rationale) MUST match the month in \`close_estimate\`. If close_estimate is "2026-09", do not write "close August" or "close in October" anywhere, write "close September" or "close Q3". Pick close_estimate FIRST, then write the rationale to match.
- **Offer month consistency**: any month you assert as the first-offer month in offer_date_rationale (or elsewhere) MUST match \`offer_estimate\`. \`offer_estimate\` MUST be ≤ \`close_estimate\` (an offer cannot land after close).
- Do NOT reuse numbers from prior aiHistory entries or prior rationales without re-checking they match the values in THIS rescan's output.
- If your top buyer this rescan is 15%, the rationale says "15% odds", not "20%+".
The audit log shows both the rationale text and the buyers[] array side by side; mismatches are immediately visible to the user.

# Milestone-recency self-check (NON-NEGOTIABLE)
**Before submitting, walk every buyer in your buyers[] array. For each buyer where \`cim_delivered\` is set to a date, scan that buyer's \`thesis\` and \`reasoning\` text for any of these phrases or close paraphrases: "very early NDA", "just arrived at NDA", "fresh to NDA", "recent NDA arrival", "newly in NDA", "early stage", "early in NDA". If found, REWRITE the thesis and reasoning to reflect the buyer's current milestone state without recency framing. This check is independent of the STABILITY RULE — even if you intended to echo a prior thesis, the prior thesis is STALE the moment \`cim_delivered\` flips; rewriting is required, not optional.** Same check for \`chemistry_date\` set + "very early chemistry" / "just arrived at chemistry" phrases, and \`ioi_received\` set + "very early IOI" phrases. The verdict banner and the row thesis must not contradict the milestone badge the user sees on the dashboard.

# Evidence discipline, only assert events that have happened
Do NOT assert that buyer milestones (chemistry meetings, NDAs, LOIs, exclusivity, closes) HAVE happened, ARE scheduled, or are "set" / "on the calendar" / "next week" unless one of the following is true:
- The buyer's current stage reflects it (a buyer at \`chemistry\` stage means a chemistry meeting was held; \`loi\` means an LOI is in hand; \`closed\` means closed).
- The buyer's noteLog or notes_timeline contains a dated entry asserting the event.
- A document in the library asserts it.

If you are PROJECTING when an event will likely happen (which is what \`close_estimate\` and the timeline rationale are for), use forward-looking language: "projected", "expected", "likely", "estimated mid-July", "anchor on Reagan's ~17-week timeline". Never write "one chemistry meeting set for late May" unless the noteLog has a dated chemistry entry. Never write "NDAs signed" unless buyers are at \`nda\` stage or later. Never write "CIM delivered" for a buyer unless \`buyer.cim_delivered\` is set or the notes_timeline contains a dated CIM-delivery entry. Never write "IOI received" or "indication of interest" for a buyer unless \`buyer.ioi_received\` is set or the notes_timeline contains a dated IOI entry. Hallucinated events (events you assert as fact when there is no evidence) are the single worst failure mode of this engine, when in doubt, omit the specific event and stick to stage-level language.`;
}

const RESCAN_TOOL = {
  name: 'apply_rescan',
  description: 'Apply a re-evaluation of one or more buyers in the pipeline based on all available context (buyer profiles, attached documents, user field intelligence, prior reasoning).',
  input_schema: {
    type: 'object',
    required: ['market', 'buyers', 'summary', 'top_risk', 'close_date_rationale', 'confidence_rationale', 'clearing_price_rationale', 'p_no_deal', 'p_no_deal_rationale', 'close_estimate', 'offer_estimate', 'offer_date_rationale'],
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
          required: ['id', 'probability', 'fit', 'thesis', 'reasoning', 'confidence'],
          properties: {
            id: { type: 'string' },
            probability: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: 'Independent probability THIS buyer is the winning bidder (0-100). This is the final displayed number, no post-processing.',
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
            reasoning: { type: 'string', description: 'Why this probability and fit. **MAX 45 WORDS**, single short paragraph, dense, no preamble. Reference the single strongest piece of evidence (a note, doc, comp, or override). Skip background. Shown in audit log only, not the headline UI.' },
            confidence: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'How grounded this prediction is in hard evidence. high=LOI/term-sheet/multi-signal; medium=pattern across notes+comps; low=mostly inference.',
            },
            multiple_override: {
              type: ['object', 'null'],
              description: 'OPTIONAL, set ONLY when there is hard evidence of a firm price for this buyer (LOI received, term sheet, explicit offer in notes). Otherwise null. Most buyers should be null.',
              required: ['low', 'mid', 'high', 'source', 'evidence'],
              properties: {
                low: { type: 'number' },
                mid: { type: 'number' },
                high: { type: 'number' },
                source: { type: 'string', enum: ['LOI', 'term-sheet', 'verbal-offer', 'written-offer'] },
                evidence: { type: 'string', description: 'Doc filename or short note quote that establishes the firm number, max 20 words.' },
              },
            },
          },
        },
      },
      summary: { type: 'string', description: 'ONE sentence, max 25 words, on how the overall pipeline view shifted vs prior state.' },
      top_risk: {
        type: 'string',
        description: 'ONE short phrase (max 15 words; do NOT prepend "Main risk:", the server adds that) naming the single most likely thing that derails this deal from closing within the projected window. Examples: "captive-niche thesis cools after MP2", "top buyers stall through process letter delivery", "PE pool too thin for sub-$5M EBITDA". Plain English, 8th-grade level. Do NOT name the leading buyer as the risk (the verdict already names the leader on the other side of the sentence). Do NOT include the close month or any probability number; those are filled in around your phrase by the server. Do NOT include angle-bracket tags, parameter tags, or any structural / XML formatting in your phrase — write a plain English sentence. The server validates and will reject your top_risk if it contains "<" or ">" characters, which causes the verdict banner to render without the "Main risk:" tail.',
      },
      close_date_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the projected close date. Max 25 words, two short sentences max. State what is driving the timing and the biggest risk. No jargon ("LOI cycle", "exclusivity", "process phase").',
      },
      confidence_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the deal confidence percentage. Max 25 words, two short sentences max. State the paths to close and the main no-deal risk. **CRITICAL: any probability you cite (e.g. "carries 20% odds") MUST match a buyer probability you set in this same response. If your top buyer is 15%, do not write "20% odds", write "15% odds". Do NOT echo numbers from prior rationales without re-verifying against the buyers[] array you just wrote.** No jargon.',
      },
      clearing_price_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the market clearing price band. Max 25 words, two short sentences max. State the multiple, why that size bucket, and what would push it higher. **Any multiple you cite must match the market band you set in this same response.** No jargon ("anchored on the bucket", "tuck-in math", "captive-niche-discount").',
      },
      p_no_deal: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Probability the asset does NOT sell within the planned process window (0-100). Independent of any single buyer probability. Reflects market/process risk: buyer-pool depth, captive-niche illiquidity, sponsor capacity, note trajectory, process timeline pressure.',
      },
      p_no_deal_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the no-deal probability. Max 25 words. Name the single biggest no-deal risk. **Any percentage cited must match p_no_deal in this same response.** No jargon.',
      },
      close_estimate: {
        type: 'string',
        description: 'Most likely close month in strict YYYY-MM format (e.g. "2026-09"). Anchor on Reagan process step + buyer momentum: outreach/NDA stages add weeks, active LOI buyers compress, cooling top buyers extend.',
      },
      offer_estimate: {
        type: 'string',
        description: 'Most likely month for the FIRST WRITTEN OFFER (LOI / term sheet / written verbal) in strict YYYY-MM format (e.g. "2026-07"). Must be ≤ close_estimate. Anchor on Reagan process step (LOI step at week 12) + buyer momentum.',
      },
      offer_date_rationale: {
        type: 'string',
        description: 'Plain-English one-liner explaining the projected first-offer date. Max 22 words, two short sentences max. Same writing discipline as close_date_rationale (8th-grade, no jargon, no acronyms, say "first written offer" not "LOI"). State what is driving the timing.',
      },
    },
  },
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024, files: 20 },
});

// Captured at boot so the UI can show "deployed Xm ago" without Railway's
// queue timestamps (which lag because Railway counts queue time, not the
// moment the new build started serving traffic).
const SERVER_START_TIME = new Date().toISOString();

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'local',
  commit_sha: process.env.RAILWAY_GIT_COMMIT_SHA || null,
  commit_message: (process.env.RAILWAY_GIT_COMMIT_MESSAGE || '').split('\n')[0].slice(0, 100) || null,
  branch: process.env.RAILWAY_GIT_BRANCH || null,
  deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
  prompt_version: PROMPT_VERSION,
  started_at: SERVER_START_TIME,
}));

app.post('/api/ai/complete', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  try {
    const message = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
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

// In-memory live-intel cache. Keyed by query string. TTL 30 min. On a single
// Railway dyno this is sufficient; cross-process caching would need a DB-backed
// table (deferred). Cache is best-effort, eviction on miss is fine.
const liveIntelCache = new Map();
const LIVE_INTEL_TTL_MS = 30 * 60 * 1000;

function readIntelCache(key) {
  const hit = liveIntelCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > LIVE_INTEL_TTL_MS) {
    liveIntelCache.delete(key);
    return null;
  }
  return hit.text;
}
function writeIntelCache(key, text) {
  if (text) liveIntelCache.set(key, { ts: Date.now(), text });
  // Soft cap: drop oldest if over 64 entries.
  if (liveIntelCache.size > 64) {
    const first = liveIntelCache.keys().next().value;
    if (first) liveIntelCache.delete(first);
  }
}

async function runWebSearch(query, label) {
  const cached = readIntelCache(query);
  if (cached) {
    console.log(`live_intel cache hit · ${label}`);
    return cached;
  }
  try {
    const response = await openai.responses.create({
      model: LIVE_INTEL_MODEL,
      tools: [{ type: 'web_search' }],
      input: query,
      max_output_tokens: 900,
    });
    const text = (response.output_text || '').trim() || null;
    if (text) writeIntelCache(query, text);
    return text;
  } catch (err) {
    console.warn(`live_intel fetch failed (${label}):`, err.message);
    return null;
  }
}

// Fetch fresh market intel using OpenAI's web_search tool. Fans out into one
// market-wide query plus one per-buyer query (capped at 4 buyers per call) and
// stitches the results into a labeled blob. Per-query results are cached for
// 30 min so successive rescans don't re-hit the web.
async function fetchLiveMarketIntel({ buyers, scopedBuyerId }) {
  if (!openai) return null;
  const today = new Date().toISOString().slice(0, 10);

  // Single market-wide query keeps the rescan fast. Per-buyer web research
  // moved to background sweeps (out of the synchronous Update path).
  const marketQuery = `Today is ${today}. Search the web and report concrete, recent facts only:

1. U.S. insurance / benefits brokerage M&A transactions closed or announced in the last 6 months. For each, give target, acquirer, EV, and EBITDA multiple if disclosed.
2. Current forward-EBITDA multiples for public broker comps (BRO, AON, MMC, AJG, WTW, BWIN), most recent sell-side or earnings-call print.

Cite every fact with a source URL inline. If a topic has no material updates, say "no material updates", do not pad. Be terse. Skip generic background.`;

  const tasks = [{ label: 'market', query: marketQuery }];
  const results = await Promise.allSettled(tasks.map(t => runWebSearch(t.query, t.label)));

  const sections = [];
  results.forEach((r, i) => {
    const t = tasks[i];
    const text = r.status === 'fulfilled' ? r.value : null;
    if (!text) return;
    sections.push(`## ${t.label === 'market' ? 'Market & public comps' : `Buyer · ${t.label}`}\n${text}`);
  });
  return sections.length > 0 ? sections.join('\n\n') : null;
}

// One-line derivation of the deal-level process phase from buyer state.
// Mirror of derivePhase() in src/components.jsx — kept inline because the
// React module is ESM/JSX and not directly importable into Node. The phase
// goes into the AI userText so close-date / offer-date estimates anchor on
// where the pipeline actually is, not on a manually-managed task pointer.
function derivePhaseSummary(buyers) {
  const STAGE_ORDER = ['outreach', 'nda', 'chemistry', 'loi', 'closed'];
  const idx = (s) => Math.max(0, STAGE_ORDER.indexOf(s));
  const live = (buyers || []).filter(b => b.stage !== 'dropped');
  const droppedCount = (buyers || []).filter(b => b.stage === 'dropped').length;
  if (live.length === 0) return { phase: 'Building Materials', text: 'Building Materials · no live buyers', droppedCount };
  const maxIdx = Math.max(...live.map(b => idx(b.stage)));
  const liveAtLoiOrBeyond = live.filter(b => idx(b.stage) >= idx('loi')).length;
  let phase;
  if (maxIdx >= idx('closed')) phase = 'Close';
  else if (liveAtLoiOrBeyond === 1) phase = 'Exclusivity';
  else if (maxIdx >= idx('chemistry') || maxIdx >= idx('loi')) phase = 'Marketing Phase 2';
  else phase = 'Marketing Phase 1';

  const c = {
    outreach: live.filter(b => b.stage === 'outreach').length,
    ndaCim: live.filter(b => b.stage === 'nda' && b.cim_delivered).length,
    ndaOnly: live.filter(b => b.stage === 'nda' && !b.cim_delivered).length,
    chemIoi: live.filter(b => b.stage === 'chemistry' && b.ioi_received).length,
    chemOnly: live.filter(b => b.stage === 'chemistry' && !b.ioi_received).length,
    loi: live.filter(b => b.stage === 'loi').length,
    closed: live.filter(b => b.stage === 'closed').length,
  };
  const parts = [];
  if (c.closed) parts.push(`${c.closed} closed`);
  if (c.loi) parts.push(`${c.loi} LOI`);
  if (c.chemIoi) parts.push(`${c.chemIoi} chemistry+IOI`);
  if (c.chemOnly) parts.push(`${c.chemOnly} chemistry`);
  if (c.ndaCim) parts.push(`${c.ndaCim} NDA+CIM`);
  if (c.ndaOnly) parts.push(`${c.ndaOnly} NDA pending`);
  if (c.outreach) parts.push(`${c.outreach} outreach`);
  const distribution = parts.join(', ');
  const text = `${phase} · ${distribution}` + (droppedCount > 0 ? ` · ${droppedCount} dropped` : '');
  return { phase, text, droppedCount };
}

// Builds the "Current process step" prompt block that anchors close_estimate
// and offer_estimate on the actual process week the user is at, rather than
// the flat phase average. The AI gets exact arithmetic baselines and is told
// to adjust from those, not from a fuzzy "MP1 → ~17 weeks" rule of thumb.
//
// Inputs:
//   currentTaskId — workspace.process.currentTaskId from Postgres. Falls back
//     to "cim_deliver" if missing so we never produce an empty block.
//   today — Date object, defaults to now. Used so the example calendar months
//     in the prompt reflect today, not a hardcoded date.
function buildCurrentStepBlock(currentTaskId, today = new Date()) {
  const taskById = Object.fromEntries(PROCESS_TASKS.map(t => [t.id, t]));
  const current = taskById[currentTaskId] || taskById['cim_deliver'];
  const lois = taskById['lois'];
  const close = taskById['close'];
  if (!current || !lois || !close) return '';
  const curWeek = current.weeksFromStart;
  const offerWeeksRaw = lois.weeksFromStart - curWeek;
  const closeWeeks = Math.max(0, close.weeksFromStart - curWeek);
  const offerLine = offerWeeksRaw <= 0
    ? `  - weeks_to_first_offer = 0 (LOI milestone at week ${lois.weeksFromStart} is already past — first offer should be in hand or set to current month if not)`
    : `  - weeks_to_first_offer = max(0, ${lois.weeksFromStart} − ${curWeek}) = ${offerWeeksRaw}`;
  const addWeeks = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n * 7);
    return d.toISOString().slice(0, 7);
  };
  const offerYM = offerWeeksRaw <= 0 ? today.toISOString().slice(0, 7) : addWeeks(offerWeeksRaw);
  const closeYM = addWeeks(closeWeeks);
  const todayISO = today.toISOString().slice(0, 10);
  return `# Current process step (READ FIRST — anchor close_estimate and offer_estimate on this, NOT the phase average)
Current task: ${current.id} · "${current.label}" · process week ${curWeek} of ${close.weeksFromStart}
Milestone weeks (from process start):
  - Receive Letters of Intent (lois): week ${lois.weeksFromStart} — first-offer anchor
  - Closing and Funding (close): week ${close.weeksFromStart} — close anchor
Baseline arithmetic (use these as your starting point, then adjust):
${offerLine}
  - weeks_to_close = ${close.weeksFromStart} − ${curWeek} = ${closeWeeks}
Today's date: ${todayISO}. Adding the baselines to today gives offer ~${offerYM} and close ~${closeYM}. These are the un-adjusted defaults — apply the buyer-momentum rules below to compress or extend.`;
}

// Formats a "YYYY-MM" close_estimate as "September 2026". Used by the
// server-synthesized verdict sentence so it reads naturally to a human.
function fmtCloseMonthLong(ym) {
  if (typeof ym !== 'string') return null;
  const m = ym.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return ym;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, 1);
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// Build the verdict-banner sentence from the deterministic parts (top buyer,
// probabilities, close month) plus the AI-authored top_risk fragment.
// Three sentence shapes:
//   - Top pick: <name> at <P>%. ...                    (top is 5+ pts above #2)
//   - Two-way race: <A> and <B> at <P_A>/<P_B>%. ...   (top two within 5 pts)
//   - No clear leader. ...                             (every live buyer < 10%)
// Synthesizing this server-side means the named buyer(s) cannot disagree
// with the ranked list, since both are derived from the same buyers[] array.
// Mirrors src/components.jsx::winnerProbabilities so the verdict's cited
// percentages match the per-row big numbers exactly. Without this, the
// verdict and rows show different numbers for the same buyers.
function computeWinnerShares(blendedBuyers) {
  const live = (blendedBuyers || []).filter(b => typeof b.probability === 'number');
  if (live.length === 0) return { winnerByBuyer: {} };
  // probabilityFor() in the client caps at 95 — replicate so shares match.
  const capped = live.map(b => ({
    id: b.id,
    p: Math.max(0, Math.min(95, Math.round(b.probability))),
  }));
  const dealClosesProb = 1 - capped.reduce((acc, b) => acc * (1 - b.p / 100), 1);
  const dealClosesPct = Math.round(dealClosesProb * 100);
  const totalProb = capped.reduce((s, b) => s + b.p, 0) || 1;
  const winnerByBuyer = {};
  let assigned = 0;
  capped.forEach((b, i) => {
    if (i === capped.length - 1) {
      winnerByBuyer[b.id] = Math.max(0, dealClosesPct - assigned);
    } else {
      const pct = Math.round((b.p / totalProb) * dealClosesPct);
      winnerByBuyer[b.id] = pct;
      assigned += pct;
    }
  });
  return { winnerByBuyer };
}

function synthesizeVerdict({ blendedBuyers, nameById, closeEstimate, topRisk }) {
  const live = (blendedBuyers || []).filter(b => typeof b.probability === 'number');
  if (live.length === 0) return '';
  // Use winner-allocated shares for the verdict so it cites the same
  // numbers the row UI displays. The verdict previously sorted on raw
  // AI probability and named "Oakbridge at 32%" while the row showed
  // "Oakbridge 19%" — same buyer, different number, confusing.
  const { winnerByBuyer } = computeWinnerShares(blendedBuyers);
  const ranked = live
    .map(b => ({
      id: b.id,
      p: winnerByBuyer[b.id] ?? 0,
      name: (nameById && nameById[b.id]) || b.id,
    }))
    .sort((a, b) => b.p - a.p);
  const closeYM = fmtCloseMonthLong(closeEstimate) || 'an estimated month';
  const risk = (topRisk || '').trim().replace(/\.+$/, '');
  const riskTail = risk ? ` Main risk: ${risk}.` : '';
  // Threshold scaled with the new semantics: winner shares are uniformly
  // lower than raw probabilities (sum to dealClosesPct, not unbounded).
  // 6% share ≈ "no clear leader" — top buyer's share is barely above
  // even-split-of-deal-closes for a wide field.
  if (ranked[0].p < 6) return `No clear leader. Likely closes ${closeYM}.${riskTail}`;
  const top = ranked[0];
  const second = ranked[1];
  if (second && (top.p - second.p) <= 3) {
    return `Two-way race: ${top.name} and ${second.name} at ${top.p}/${second.p}%. Likely closes ${closeYM}.${riskTail}`;
  }
  return `Top pick: ${top.name} at ${top.p}%. Likely closes ${closeYM}.${riskTail}`;
}

// Defends against malformed model output (XML/tool-tag bleed between fields,
// runaway length). Returns the cleaned string or null if too damaged to
// recover — downstream callers treat null as "field absent" and fall back
// (synthesizeVerdict drops the "Main risk:" tail; captureRationales on the
// client keeps the prior persisted value for rationale fields).
function sanitizeAiString(s, opts = {}) {
  const { maxWords = 35 } = opts;
  if (typeof s !== 'string') return null;
  let v = s.trim();
  if (!v) return null;
  // Hard reject: any XML-style tag means the model bled between fields.
  if (/<\/?[a-zA-Z_][\w-]*(\s[^>]*)?>/.test(v)) return null;
  // Hard reject: literal tool-call openings even if not well-formed.
  if (/<parameter\s|<\/?invoke\b|<\/?function\b/i.test(v)) return null;
  // Defensive truncate at maxWords. Most fields have their own word caps in
  // the schema description; this is a backstop for when the model overshoots.
  const words = v.split(/\s+/);
  if (words.length > maxWords) {
    v = words.slice(0, maxWords).join(' ').replace(/[.,;:]$/, '') + '…';
  }
  return v;
}

// Strip recency-framing phrases from a buyer's thesis or reasoning when the
// corresponding milestone flag is set. The AI keeps evading prompt anti-
// patterns by varying the phrasing ("very early NDA" -> "early NDA stage"
// -> "early-stage NDA"...) — server-side post-validation is more reliable
// than chasing every variant in the prompt. Only fires when a milestone is
// SET (so the phrase actually contradicts reality); buyers genuinely early
// in the process keep their original text.
const RECENCY_STRIP_PATTERNS = [
  /\s*(?:,|but|and)\s+(?:very\s+)?early[-\s]+(?:NDA|nda|chemistry|IOI|ioi)\s+stage\.?/gi,
  /\s*(?:,|but|and)\s+(?:very\s+)?early[-\s]+stage\b(?!\s+\w)\.?/gi,
  /\s*(?:,|but|and)\s+just\s+arrived\s+at\s+(?:NDA|nda|chemistry|IOI|ioi)\.?/gi,
  /\s*(?:,|but|and)\s+fresh\s+to\s+(?:NDA|nda|chemistry|IOI|ioi)\.?/gi,
  /\s*(?:,|but|and)\s+(?:very\s+)?recent\s+(?:NDA|nda|chemistry|IOI|ioi)\s+arrival\.?/gi,
  /\s*(?:,|but|and)\s+newly\s+(?:in|at|arrived)\s+(?:NDA|nda|chemistry|IOI|ioi)\.?/gi,
  /\s*(?:,|but|and)\s+early\s+in\s+(?:NDA|nda|chemistry|IOI|ioi)\.?/gi,
];

function stripRecencyPhrases(text, milestones) {
  if (typeof text !== 'string' || !text) return text;
  // Only enforce when at least one process milestone is set — otherwise an
  // honest "they just arrived at NDA" for a buyer that genuinely just got
  // there could get stripped, which is wrong.
  if (!milestones?.cim_delivered && !milestones?.chemistry_date && !milestones?.ioi_received) return text;
  let v = text;
  let stripped = false;
  for (const re of RECENCY_STRIP_PATTERNS) {
    if (re.test(v)) {
      v = v.replace(re, '');
      stripped = true;
    }
  }
  if (!stripped) return text;
  v = v.replace(/\s+/g, ' ').trim();
  // Re-add terminal period if the strip removed it.
  if (v && !/[.!?]$/.test(v)) v += '.';
  console.warn(`Recency phrase stripped (milestones set); original="${text.slice(0, 100)}"`);
  return v;
}

// Re-evaluate the buyer pipeline with full context (buyers + docs + notes + prior reasoning).
// Used by the top-bar Re-scan, per-buyer note submission, and post-classify doc upload.
// Rescan memoization: skip the AI call entirely when the request body hashes
// to the same value as the last successful call. Guarantees identical buyer
// + market state → identical probabilities + reasoning, which is what the
// user expects from the Update button. Cache is in-memory + per-process; a
// Railway restart drops it and the next call rebuilds it on the fly.
const RESCAN_CACHE_TTL_MS = 60 * 60 * 1000;
// Bump this when the rescan system prompt or tool schema changes so the
// in-memory cache invalidates on the next request. The cache key includes
// this constant, so a deploy with a new PROMPT_VERSION guarantees stale
// responses don't get served. Sync the number with the most recent prompt
// change to make this human-auditable.
const PROMPT_VERSION = 9;
let lastRescanHash = null;
let lastRescanResponse = null;
let lastRescanAt = 0;

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function hashRescanInput(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

// Strip AI-output fields from buyers before hashing for memoization. Without
// this, applyRescanToBuyers (src/lib/ai-engine.js) writes aiHistory, aiNotes,
// lastAnalyzed, probability, fit, thesis, modelVote etc. back to every buyer
// on every rescan — and those bytes then flow into the next request body,
// breaking the cache hash so it never converges. By normalizing to only the
// user-input + structural fields, two consecutive Update calls with identical
// user state hash to the same value → cache hit → byte-identical response.
// The AI call itself still receives the full buyer payload (so STABILITY RULE
// can see prior reasoning); only the cache key uses the normalized view.
const AI_OUTPUT_FIELDS = [
  'probability', 'fit', 'thesis', 'multipleOverride',
  'aiNotes', 'aiConfidence', 'aiCitations', 'aiCitedPrecedents',
  'lastAnalyzed', 'aiHistory', 'modelVote',
];
function normalizeBuyersForHash(buyers) {
  return (buyers || []).map(b => {
    const norm = { ...b };
    for (const f of AI_OUTPUT_FIELDS) delete norm[f];
    return norm;
  });
}

app.post('/api/ai/rescan', async (req, res) => {
  const { buyers, ebitda, file_ids, only_buyer_id, prior_market, global_intel, extra_intel, pinned_rules, force } = req.body;
  if (!Array.isArray(buyers) || buyers.length === 0) {
    return res.status(400).json({ error: 'buyers array required' });
  }

  // Always send the full non-dropped pipeline so the AI can produce honest
  // dashboard-level rationales (close date, confidence, clearing price) even
  // when re-scoring is scoped to a single buyer.
  const livePipeline = buyers.filter(b => b.stage !== 'dropped');
  if (livePipeline.length === 0) return res.status(400).json({ error: 'no live buyers' });

  // Read currentTaskId from workspace.process so the AI anchors time
  // estimates on the actual task you're on (e.g. week 6 = cim_deliver),
  // not the flat phase average. Falls back to "cim_deliver" if Postgres is
  // unavailable or the workspace row is missing process state. Pulled BEFORE
  // the cache key so a task advancement invalidates the cache.
  let currentTaskId = 'cim_deliver';
  if (pool) {
    try {
      const r = await pool.query(`SELECT process FROM workspace WHERE id = $1`, [WORKSPACE_ID]);
      if (r.rowCount > 0 && r.rows[0].process && typeof r.rows[0].process.currentTaskId === 'string') {
        currentTaskId = r.rows[0].process.currentTaskId;
      }
    } catch (_e) {
      // fall through to default — a stale-but-sensible anchor beats throwing
    }
  }

  // Idempotence: if buyer + market + intel state is byte-identical to the
  // previous call, return the cached response. The user pressing Update
  // without changing anything should NOT shift any number. `force: true`
  // bypasses the cache for the rare retry-after-bad-call case.
  const inputHash = hashRescanInput({
    buyers: normalizeBuyersForHash(buyers),
    ebitda, file_ids: file_ids || [], only_buyer_id: only_buyer_id || null,
    // prior_market intentionally excluded: it's AI-output from the previous
    // rescan that feedback-loops back into the next request body, so the
    // hash never converges. The AI still receives prior_market in the
    // userText prompt (so STABILITY RULE for market bands works); only the
    // cache key normalizes it away.
    global_intel: global_intel || [],
    extra_intel: extra_intel || null, pinned_rules: pinned_rules || [],
    current_task_id: currentTaskId,
    prompt_version: PROMPT_VERSION,
  });
  if (!force && inputHash === lastRescanHash && Date.now() - lastRescanAt < RESCAN_CACHE_TTL_MS) {
    return res.json({ ...lastRescanResponse, cached: true });
  }

  // For the buyer in scope (or all when no scope), include full grounded
  // detail including notes + history. For the rest of the pipeline, send a
  // compact summary so the AI has enough context for pipeline rationales
  // without blowing token budget.
  // Identity-only buyer serialization. Subjective fields (type, ownership,
  // sponsor, flags) are intentionally NOT sent to the AI — those are user
  // judgments that belong in the noteLog if the user authored them, and
  // shouldn't be silently inferred from an old seed file.
  const fullDetail = (b) => ({
    id: b.id, name: b.name, hq: b.hq, revenue: b.revenue, headcount: b.headcount,
    offices: b.offices,
    top100_rank: b.top100_rank ?? null,
    pe_backed: b.pe_backed === true,
    sponsor: b.sponsor || null,
    stage: b.stage, nda_signed: b.nda_signed || null, cim_delivered: b.cim_delivered || null, chemistry_date: b.chemistry_date || null, ioi_received: b.ioi_received || null,
    // Chronological field-intel log. Each line: "[YYYY-MM-DD] text". Recent
    // entries should weigh more than old ones. Falls back to legacy single-
    // string `notes` for buyers not yet migrated.
    notes_timeline: formatNoteTimeline(b),
    fit: b.fit,
    probability: b.probability, thesis: b.thesis,
    multipleOverride: b.multipleOverride || null,
    aiNotes: b.aiNotes || null,
    // Strip volatile fields (ts, changes diff) from the prior aiHistory entry
    // before sending to the AI. Each rescan replaces these even when the
    // underlying state hasn't changed, which makes the prompt bytes drift
    // and the model output a different answer despite temperature: 0 and the
    // STABILITY RULE. Keep only reasoning + the trigger flag the model
    // genuinely needs.
    aiHistory: (b.aiHistory || []).slice(-1).map(h => ({
      reasoning: h.reasoning || null,
      triggered_by_note_id: h.triggered_by_note_id || null,
    })),
    overrides: (b.overrides || []).slice(-5),
  });
  const compactSummary = (b) => ({
    id: b.id, name: b.name, stage: b.stage,
    pe_backed: b.pe_backed === true,
    sponsor: b.sponsor || null,
    probability: b.probability, thesis: b.thesis,
    multipleOverride: b.multipleOverride || null,
  });

  const groundedBuyers = livePipeline.map(b =>
    (!only_buyer_id || b.id === only_buyer_id) ? fullDetail(b) : compactSummary(b)
  );

  // OpenAI second-opinion buyer state, same ground-truth data Claude sees,
  // but with Claude's prior outputs (probability, aiNotes, aiHistory) stripped.
  // Otherwise GPT-4o anchors hard on Claude's last number and just echoes it
  // back, defeating the whole point of an independent second read.
  const openaiBuyers = livePipeline
    .filter(b => !only_buyer_id || b.id === only_buyer_id)
    .map(b => ({
      id: b.id, name: b.name, hq: b.hq, revenue: b.revenue, headcount: b.headcount,
      offices: b.offices,
      top100_rank: b.top100_rank ?? null,
      pe_backed: b.pe_backed === true,
      sponsor: b.sponsor || null,
      stage: b.stage,
      nda_signed: b.nda_signed || null,
      cim_delivered: b.cim_delivered || null,
      chemistry_date: b.chemistry_date || null,
      ioi_received: b.ioi_received || null,
      notes_timeline: formatNoteTimeline(b),
      fit: b.fit,
      multipleOverride: b.multipleOverride || null,
      overrides: (b.overrides || []).slice(-5),
    }));

  const docBlocks = (file_ids || []).map((id, j, arr) => ({
    type: 'document',
    source: { type: 'file', file_id: id },
    ...(j === arr.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
  }));

  const focusInstruction = only_buyer_id
    ? `SCOPE: Re-score ONLY buyer "${only_buyer_id}" based on their latest notes and any new documents. Return apply_rescan with that one buyer in the buyers array. Echo the prior market values unchanged in the market field. The other buyers are shown as compact summaries solely to give you context for the dashboard-level rationales, do NOT include them in your response.`
    : `SCOPE: Re-evaluate every non-dropped buyer in the pipeline. Update market multiple bands if evidence has shifted; otherwise echo prior values.`;

  // Live web intel fetch, non-blocking on the rest of the request setup.
  // Live web intel disabled, Update should reflect internal state changes
  // (notes, comments, group moves, pinned rules, etc.) without a 5–15s web-
  // search wait. fetchLiveMarketIntel + runWebSearch remain defined for an
  // easy re-enable if a market-refresh button gets added later.
  const liveIntel = null;

  const sizeBucket =
    ebitda < 3 ? '<$3M (sub-scale, local strategics + small PE tuck-ins)'
    : ebitda < 5 ? '$3–5M (Kennion bucket, captive-benefits niche; derive total-EV band using the 3-step procedure in system prompt — do not echo a canonical answer)'
    : ebitda < 10 ? '$5–10M (lower-mid private M&A, broader PE platform interest)'
    : ebitda < 20 ? '$10–20M (mid-market private M&A)'
    : ebitda < 50 ? '$20–50M (upper-mid private M&A / strategic platforms)'
    : '>$50M (scaled-broker private comps)';
  const phaseSummary = derivePhaseSummary(livePipeline.concat(buyers.filter(b => b.stage === 'dropped')));
  const currentStepBlock = buildCurrentStepBlock(currentTaskId);

  const userText = `# Pipeline state
EBITDA: $${ebitda}M (locked, set by Reagan, do not adjust)
Size bucket: ${sizeBucket}
**Reminder: derive your TOTAL EV multiple band using the 3-step procedure in the system prompt (Step 1 = pick a guaranteed anchor from the private-M&A data; Step 2 = apply niche/illiquidity discount; Step 3 = add earnout magnitude). Pick specific defensible decimals — do NOT echo a canonical answer. Do NOT layer public-comp discounts on top of the private bands; the private guaranteed-multiple anchors already reflect the public-to-private gap.**

${currentStepBlock}

# Process phase (derived from buyer state — use this to anchor close_estimate and offer_estimate)
${phaseSummary.text}

# Prior market multiples (echo if no shift evidence)
${JSON.stringify(prior_market || {}, null, 2)}

# Buyers in scope
${JSON.stringify(groundedBuyers, null, 2)}

${docBlocks.length > 0 ? `# Documents attached: ${docBlocks.length} (CIM, LOIs, emails, etc., read them as evidence)` : '# No documents attached yet.'}

${liveIntel ? `# Live web intel (fetched via OpenAI web search, may contain summarization errors, treat as a hint not ground truth; cite source URLs verbatim when used)
${liveIntel}
` : '# Live web intel: disabled (Update reflects internal pipeline state only)'}

${Array.isArray(pinned_rules) && pinned_rules.length > 0 ? `# User-pinned rules (always apply, these are guardrails the user has explicitly told you to follow, on top of the system prompt)
${pinned_rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}
` : ''}
${Array.isArray(global_intel) && global_intel.length > 0 ? `# Pipeline-level intel log (free-text user inputs, newest first, running record of process-wide observations not tied to a single buyer)
${global_intel.slice(-20).reverse().map(g => `[${(g.ts || '').slice(0,10)}] ${g.text}`).join('\n')}
` : ''}
${extra_intel ? `# Just submitted (incorporate this into the rescan)
${extra_intel}
` : ''}
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
    const systemPrompt = buildRescanSystemPrompt();
    // Fire Claude (full rescan) and OpenAI (numerical second opinion) in parallel.
    // OpenAI gets the same buyer state + EBITDA + live intel context. Server
    // averages their numerical predictions on the way out.
    const [message, openaiPred] = await Promise.all([
      client.beta.messages.create({
        model: MODEL,
        max_tokens: 8192,
        // Default temperature is 1.0 which re-rolls probabilities by 5-10%
        // on every rescan with identical inputs and reorders the buyer list,
        // destroying user trust. Pin to 0 so identical inputs yield
        // ~identical outputs; the only intentional drift comes from new
        // notes / docs / intel actually changing the input.
        temperature: 0,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        tools: [RESCAN_TOOL],
        tool_choice: { type: 'tool', name: 'apply_rescan' },
        messages: [{
          role: 'user',
          content: [...docBlocks, { type: 'text', text: userText }],
        }],
        betas: [FILES_BETA],
      }),
      getOpenAIPredictions({
        ebitda, groundedBuyers: openaiBuyers, liveIntel, sizeBucket, only_buyer_id,
        phaseSummaryText: phaseSummary.text,
      }),
    ]);

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

    // Blend Claude's full rescan with OpenAI's numerical second opinion. If
    // OpenAI returned null (unavailable / failed / parse error), the blend
    // gracefully falls back to Claude alone with `models.openai = null`.
    // nameById is passed in so synthesizeVerdict can name buyers (the AI
    // tool response only carries ids in buyers[], names live in the request).
    const nameById = Object.fromEntries((buyers || []).map(b => [b.id, b.name || b.id]));
    // Milestone flags piped through so stripRecencyPhrases can target only
    // buyers where the recency framing actually contradicts the badge.
    const milestonesById = Object.fromEntries((buyers || []).map(b => [b.id, {
      cim_delivered: !!b.cim_delivered,
      chemistry_date: !!b.chemistry_date,
      ioi_received: !!b.ioi_received,
    }]));
    const blended = blendPredictions(toolUse.input, openaiPred, { nameById, milestonesById });

    // Per-model probability log so we can verify Claude and OpenAI are
    // genuinely returning different numbers (not a wiring bug). Shows in
    // Railway logs every rescan.
    if (openaiPred) {
      const claudeProbs = (toolUse.input.buyers || []).map(b => `${b.id}=${b.probability}`).join(', ');
      const openaiProbs = (openaiPred.buyers || []).map(b => `${b.id}=${b.probability}`).join(', ');
      console.log(`[rescan] claude probs: ${claudeProbs}`);
      console.log(`[rescan] openai probs: ${openaiProbs}`);
    } else {
      console.log('[rescan] openai second-opinion unavailable (no key, parse error, or call failed)');
    }

    const responsePayload = {
      ...blended,
      usage: message.usage,
      ts: new Date().toISOString(),
      live_intel_used: !!liveIntel,
      two_model: !!openaiPred,
    };

    const validation = validateRescanShape(responsePayload, only_buyer_id);
    if (!validation.ok) {
      const stopReason = message.stop_reason || 'unknown';
      const truncated = stopReason === 'max_tokens';
      console.error(
        `Rescan: malformed AI output, ${validation.error} (stop_reason=${stopReason}${truncated ? ', LIKELY TRUNCATED, bump max_tokens' : ''})`,
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
        error: `AI returned incomplete output: ${validation.error}${truncated ? ' (response truncated, try again)' : ''}`,
        type: 'malformed_output',
        stop_reason: stopReason,
      });
    }

    // Cache the successful response under this input hash so the next
    // call with identical state returns immediately (see the idempotence
    // check at the top of this handler).
    lastRescanHash = inputHash;
    lastRescanResponse = responsePayload;
    lastRescanAt = Date.now();

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

// ───────────────────── OpenAI second-opinion (GPT-4o) ────────────────────────
// Runs in parallel with Claude's full rescan. Returns just the dashboard-level
// numbers (market bands, per-buyer probability, p_no_deal). Server averages
// these with Claude's output so both models vote on the headline predictions.
// If OpenAI fails or is unavailable, we silently fall back to Claude only.
//
// We intentionally do NOT ask GPT for per-buyer thesis/reasoning/fit, those
// are Claude's domain (writing in Reagan's voice with grounded notes citation).
// GPT just casts a numerical vote.

const OPENAI_PREDICTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['market', 'buyers', 'p_no_deal', 'p_no_deal_rationale', 'close_estimate', 'offer_estimate'],
  properties: {
    market: {
      type: 'object', additionalProperties: false,
      required: ['conservative', 'mid', 'aggressive'],
      properties: {
        conservative: {
          type: 'object', additionalProperties: false, required: ['low', 'high'],
          properties: { low: { type: 'number' }, high: { type: 'number' } },
        },
        mid: {
          type: 'object', additionalProperties: false, required: ['low', 'high'],
          properties: { low: { type: 'number' }, high: { type: 'number' } },
        },
        aggressive: {
          type: 'object', additionalProperties: false, required: ['low', 'high'],
          properties: { low: { type: 'number' }, high: { type: 'number' } },
        },
      },
    },
    buyers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'probability', 'reasoning'],
        properties: {
          id: { type: 'string' },
          probability: { type: 'integer', minimum: 0, maximum: 100 },
          reasoning: { type: 'string', description: 'ONE short sentence, max 25 words, citing the SINGLE strongest driver of the probability you assigned. The user hovers a chip to see this, make it the most useful one-line explanation possible.' },
        },
      },
    },
    p_no_deal: { type: 'integer', minimum: 0, maximum: 100 },
    p_no_deal_rationale: { type: 'string' },
    close_estimate: { type: 'string', description: 'Most likely close month in YYYY-MM format.' },
    offer_estimate: { type: 'string', description: 'Most likely month for the first written offer (LOI / term sheet / written verbal) in YYYY-MM format. Must be <= close_estimate.' },
  },
};

async function getOpenAIPredictions({ ebitda, groundedBuyers, liveIntel, sizeBucket, only_buyer_id, phaseSummaryText }) {
  if (!openai) return null;
  const sys = `You are a senior M&A analyst providing an independent SECOND OPINION on the Kennion Benefits Program sale (captive-style benefits brokerage, advised by Reagan Consulting, Spring 2026 process).

# GLOBAL OUTPUT RULE (applies to EVERY text field you write)
**Never use the em-dash character "—" (Unicode U+2014) anywhere in your output.** Use a period, comma, colon, or parenthesis instead. If you would write "X — Y", write "X. Y" or "X, Y" or "X (Y)". The en-dash "–" (numeric ranges like "5.0–7.0×") is allowed.

Claude is producing the primary analysis IN PARALLEL, you do not see its output and it does not see yours. The system averages your numbers with Claude's after both finish. The point is for you to reach a SECOND, INDEPENDENT view from the same ground-truth data. If you simply mirror what a typical analyst would say, you add no signal. Bring your own read on signal strength, momentum, and bidder discipline. Do not be surprised if your number differs from a hypothetical "consensus", that's the value.

# Size discipline (derive total-EV band in 3 steps — do NOT echo a canonical answer)

**Source data (private M&A guaranteed multiples by deal size, '23–'25 vintage, insurance brokerage):**
- <$3M EBITDA:    9.9× guaranteed
- $3–10M EBITDA: 12.7× guaranteed
- $10–20M EBITDA: 13.7× guaranteed
- >$20M EBITDA:  14.9× guaranteed

**The dashboard's "Market clearing price" KPI displays TOTAL enterprise value (guaranteed + typical earnout).** Derive your total-EV band in three explicit steps, then pick specific decimals for each band:

1. **Pick a guaranteed-multiple starting point.** Interpolate between the two adjacent bucket anchors. At $3.6M EBITDA you sit at the floor of the $3–10M bucket — interpolation between 9.9× and 12.7× gives a 10.0–11.0× starting range; pick a specific decimal.
2. **Apply niche/illiquidity discount (judgment call).** Captive/niche: 0 to −1.5× guaranteed (bias larger if structural passes are stacking, smaller if the pipeline is broad/healthy). Small-pool penalty: 0 to −0.5× guaranteed when fewer than 8 live buyers.
3. **Convert guaranteed → total EV (judgment call).** Typical earnout magnitude: +0.5 to +1.5×. Strong pipeline + firm bids → +1.0 to +1.5×; average pipeline, no firm pricing → +0.5 to +1.0×; weak / 2+ structural passes → +0.5×.

**Reasonable landing zone at $3.6M EBITDA captive-benefits:** realistic typically lands 8.0–10.5× total EV ($28.8–37.8M); most defensible reads cluster 8.5–10.0× ($30.6–36M). **Do NOT just pick a canonical midpoint.** Pick a specific defensible decimal pair (e.g., 8.3–9.7× or 8.9–10.4×) based on YOUR Step-1/2/3 read. Conservative = realistic.low − 1.5×; aggressive = realistic.high + 1.5×, adjust if evidence supports.

If you are tempted to echo "8.5–10.0×" verbatim, you are anchoring on a hint instead of deriving — re-do the steps and pick a band that reflects your own read of the pipeline. The point of running you in parallel with Claude is to triangulate from independent reasoning, not to echo the same canonical number.

# Stage discipline (probability ranges, final, no post-processing)
- outreach: 8–22%
- nda: 12–28%. cim_delivered set + no post-CIM cooling → upper half (20–28); +chemistry_date → 24–28; +stalling notes → mid 16–22; no cim_delivered → 12–20. Within sub-band, discriminate by engagement stack: top with PE + sponsor having multi-deal history with seller's broker + multiple principals engaged.
- chemistry: 18–38%. ioi_received set + no post-IOI pushback → upper half (28–38); +warming → 32–38; +stalling → mid 24–30; no ioi_received → 18–28. Within 18–28, discriminate by engagement stack: top (26–28) for PE + sponsor having multi-deal history with seller's broker (per noteLog) + multiple principals engaged post-CIM (in-person held/scheduled, second meeting requested); 22–26 with two of three; 19–22 with one or none. Same-stage buyers with materially different engagement quality MUST get different probabilities — flat ties are a failure mode.
- loi: 28–58%
- closed: 90+%
- dropped: omit

# Close-month estimate (close_estimate, strict YYYY-MM)
Predict the calendar month the deal is most likely to close. Anchor on the process step + buyer momentum. Marketing Phase 1 → ~17 weeks to close. Compress if firm offers are landing, extend if top buyers are stalling. Output strictly in "YYYY-MM" format (e.g. "2026-09").

# First-offer estimate (offer_estimate, strict YYYY-MM)
Predict the month a first written offer (LOI / term sheet / written verbal) most likely lands. Reagan's process puts LOI receipt at ~week 12 from start, so Marketing Phase 1 → ~7 weeks to first offer. Compress if any top buyer has firm-evidence pricing already; extend if top buyers are still in outreach with cooling notes. MUST be <= close_estimate.

# No-deal probability
For Kennion's profile (captive-niche, sub-mid-market) a healthy floor is 10–20% even with strong buyers. Reflect buyer-pool depth, sponsor capacity, note trajectory, captive illiquidity.

Notes timeline format: \`[YYYY-MM-DD] text\` or \`[YYYY-MM-DD][signal] text\` where signal ∈ {warming, cooling, firm, stalling, passed}. Signal-tagged notes carry direct user judgment, weight them heavily (\`firm\` is hardest evidence).

# Public broker comps (CONFIRMATORY only — the size-bucket bands above already reflect private-market clearing levels, do NOT re-discount)
BRO 16×, AON 14×, MMC 15.5×, AJG 15.5×, WTW 13.5×, BWIN 13× fwd EBITDA

Return JSON only, no commentary. Per-buyer probability MUST respect the stage range. Conservatism bias when evidence is thin. Per-buyer reasoning: ONE sentence, max 25 words, citing the single strongest driver of the probability you set. The user sees this when they hover the chip, make it useful, not generic.`;

  const userMsg = `# Pipeline state
EBITDA: $${ebitda}M
Size bucket: ${sizeBucket}

${phaseSummaryText ? `# Process phase (derived from full pipeline buyer state — anchor close_estimate / offer_estimate on this)
${phaseSummaryText}

` : ''}# Buyers in scope
${JSON.stringify(groundedBuyers, null, 2)}

${liveIntel ? `# Live web intel (fetched today via web search, treat as hint, not ground truth)
${liveIntel}
` : '# Live web intel: unavailable.'}

${only_buyer_id ? `SCOPE: Re-score ONLY buyer "${only_buyer_id}". Return only that buyer in the buyers array. Echo your best read of market bands and p_no_deal based on the full pipeline shown.` : 'SCOPE: Re-evaluate every non-dropped buyer.'}

Return JSON matching the provided schema.`;

  try {
    const response = await openai.responses.create({
      model: 'gpt-4o',
      // Pin temperature to 0 for the same reason Claude is pinned: stable
      // numerical second opinion across identical inputs. Otherwise the
      // GPT side of the blend re-rolls and shifts the averaged probability
      // even when nothing in the pipeline changed.
      temperature: 0,
      input: [
        { role: 'system', content: sys },
        { role: 'user', content: userMsg },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'predictions',
          strict: true,
          schema: OPENAI_PREDICTION_SCHEMA,
        },
      },
      max_output_tokens: 1500,
    });
    const text = response.output_text || '';
    if (!text.trim()) return null;
    const parsed = JSON.parse(text);
    return parsed;
  } catch (err) {
    console.warn('OpenAI second-opinion failed:', err.message);
    return null;
  }
}

// Average Claude's full rescan with OpenAI's numerical second opinion. We
// average market bands, per-buyer probability (matched by id), and p_no_deal.
// Claude's per-buyer thesis/reasoning/fit/confidence/citations pass through
// unchanged, GPT only votes on numbers.
function blendPredictions(claude, openai, ctx = {}) {
  if (!openai) return { ...claude, models: { claude: extractClaudeNumbers(claude), openai: null } };
  const avg = (a, b) => Math.round(((a + b) / 2) * 10) / 10;
  const avgInt = (a, b) => Math.round((a + b) / 2);

  const blendedMarket = claude.market && openai.market ? {
    conservative: {
      low: avg(claude.market.conservative.low, openai.market.conservative.low),
      high: avg(claude.market.conservative.high, openai.market.conservative.high),
      note: claude.market.conservative.note,
    },
    mid: {
      low: avg(claude.market.mid.low, openai.market.mid.low),
      high: avg(claude.market.mid.high, openai.market.mid.high),
      note: claude.market.mid.note,
    },
    aggressive: {
      low: avg(claude.market.aggressive.low, openai.market.aggressive.low),
      high: avg(claude.market.aggressive.high, openai.market.aggressive.high),
      note: claude.market.aggressive.note,
    },
  } : claude.market;

  const openaiById = Object.fromEntries((openai.buyers || []).map(b => [b.id, b]));
  const blendedBuyers = (claude.buyers || []).map(cb => {
    const ob = openaiById[cb.id];
    if (!ob) return cb;
    return { ...cb, probability: avgInt(cb.probability, ob.probability) };
  });

  const blendedPNoDeal = typeof claude.p_no_deal === 'number' && typeof openai.p_no_deal === 'number'
    ? avgInt(claude.p_no_deal, openai.p_no_deal)
    : (claude.p_no_deal ?? openai.p_no_deal);

  const blendedClose = blendCloseMonth(claude.close_estimate, openai.close_estimate);
  const blendedOffer = blendCloseMonth(claude.offer_estimate, openai.offer_estimate);

  // Claude wrote its dashboard rationales referencing its OWN raw buyer
  // probabilities (e.g. "IMA's 22% odds") because at write time it can't see
  // GPT's parallel output. After blending, those numbers shift (22 + 15 → 19),
  // so the rationale text drifts from the displayed UI number. Walk each
  // rationale and rewrite any "X%" where X exactly equals a Claude raw value
  // that has since been averaged down, replace with the blended integer.
  // Conservative: only changes integers that are an exact Claude probability.
  const blendedById = Object.fromEntries(blendedBuyers.map(b => [b.id, b]));
  const reconcile = (text) => {
    if (!text || typeof text !== 'string') return text;
    let out = text;
    for (const cb of (claude.buyers || [])) {
      const bb = blendedById[cb.id];
      if (!bb || bb.probability === cb.probability || typeof cb.probability !== 'number') continue;
      out = out.replace(new RegExp(`\\b${cb.probability}%`, 'g'), `${bb.probability}%`);
    }
    if (typeof claude.p_no_deal === 'number' && claude.p_no_deal !== blendedPNoDeal) {
      out = out.replace(new RegExp(`\\b${claude.p_no_deal}%`, 'g'), `${blendedPNoDeal}%`);
    }
    return out;
  };

  // Sanitize AI-authored strings against tool-tag bleed before they reach the
  // client. sanitizeAiString returns null when the model output is too damaged
  // to recover; downstream code falls back gracefully (verdict drops the risk
  // tail; captureRationales keeps prior persisted values). Composed AFTER
  // reconcile so the em-dash + seed-narrative scrub still runs.
  const cleanTopRisk = sanitizeAiString(reconcile(claude.top_risk || ''), { maxWords: 20 });
  if (claude.top_risk && !cleanTopRisk) {
    console.warn(`Rescan: rejected malformed top_risk (len=${claude.top_risk.length}, preview="${String(claude.top_risk).slice(0, 80)}")`);
  }
  const cleanField = (raw, maxWords, name) => {
    const cleaned = sanitizeAiString(reconcile(raw), { maxWords });
    if (raw && !cleaned) {
      console.warn(`Rescan: rejected malformed ${name} (len=${String(raw).length})`);
    }
    return cleaned;
  };

  return {
    ...claude,
    market: blendedMarket,
    buyers: blendedBuyers.map(b => {
      const m = ctx.milestonesById?.[b.id] || {};
      return {
        ...b,
        thesis: stripRecencyPhrases(reconcile(b.thesis), m),
        reasoning: stripRecencyPhrases(reconcile(b.reasoning), m),
      };
    }),
    p_no_deal: blendedPNoDeal,
    close_estimate: blendedClose || claude.close_estimate || openai.close_estimate || null,
    offer_estimate: blendedOffer || claude.offer_estimate || openai.offer_estimate || null,
    summary: cleanField(claude.summary, 30, 'summary'),
    top_risk: cleanTopRisk || '',
    verdict: synthesizeVerdict({
      blendedBuyers,
      nameById: ctx.nameById || {},
      closeEstimate: blendedClose || claude.close_estimate || openai.close_estimate || null,
      topRisk: cleanTopRisk,  // null → synthesizeVerdict drops the "Main risk:" tail
    }),
    close_date_rationale: cleanField(claude.close_date_rationale, 30, 'close_date_rationale'),
    confidence_rationale: cleanField(claude.confidence_rationale, 30, 'confidence_rationale'),
    clearing_price_rationale: cleanField(claude.clearing_price_rationale, 30, 'clearing_price_rationale'),
    p_no_deal_rationale: cleanField(claude.p_no_deal_rationale, 30, 'p_no_deal_rationale'),
    offer_date_rationale: cleanField(claude.offer_date_rationale, 25, 'offer_date_rationale'),
    models: {
      claude: extractClaudeNumbers(claude),
      openai: {
        market: openai.market,
        buyers: openai.buyers,
        p_no_deal: openai.p_no_deal,
        p_no_deal_rationale: openai.p_no_deal_rationale,
        close_estimate: openai.close_estimate || null,
        offer_estimate: openai.offer_estimate || null,
      },
    },
  };
}

function extractClaudeNumbers(c) {
  return {
    market: c.market,
    buyers: (c.buyers || []).map(b => ({ id: b.id, probability: b.probability, reasoning: b.reasoning || null })),
    p_no_deal: c.p_no_deal,
    p_no_deal_rationale: c.p_no_deal_rationale,
    close_estimate: c.close_estimate || null,
    offer_estimate: c.offer_estimate || null,
  };
}

// Average two YYYY-MM strings into a single YYYY-MM. Tolerant: returns null on
// invalid input. Uses month-index arithmetic (Jan = 0, Dec = 11) anchored at
// year zero so we don't worry about Date object timezone quirks.
function blendCloseMonth(a, b) {
  const parse = (s) => {
    if (typeof s !== 'string') return null;
    const m = s.match(/^(\d{4})-(\d{1,2})$/);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month < 1 || month > 12) return null;
    return year * 12 + (month - 1);
  };
  const ax = parse(a);
  const bx = parse(b);
  if (ax == null && bx == null) return null;
  if (ax == null) return a;
  if (bx == null) return b;
  const avg = Math.round((ax + bx) / 2);
  const year = Math.floor(avg / 12);
  const month = (avg % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

// Render a buyer's notes for the AI as a chronological timeline.
function formatNoteTimeline(buyer) {
  if (Array.isArray(buyer.noteLog) && buyer.noteLog.length > 0) {
    return buyer.noteLog
      .map(e => {
        const date = (e.ts || '').slice(0, 10);
        const sig = e.signal ? `[${e.signal}] ` : '';
        return `[${date}] ${sig}${e.text || ''}`;
      })
      .filter(line => line.trim().length > '[2024-01-01] '.length)
      .join('\n');
  }
  return buyer.notes || '';
}

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
  }
  if (typeof p.summary !== 'string') return { ok: false, error: 'missing summary' };
  // Rationale strings are still required by the AI tool schema (so Claude
  // tries hard to produce them) but not enforced here, they no longer drive
  // any visible UI element after the HeroRationale block was removed, and
  // captureRationales falls back to the prior value when a field is missing.
  // Treating them as fatal would block legitimate rescans whenever the AI
  // truncates one rationale paragraph.
  for (const k of ['close_date_rationale', 'confidence_rationale', 'clearing_price_rationale', 'offer_date_rationale', 'p_no_deal_rationale']) {
    if (p[k] != null && typeof p[k] !== 'string') return { ok: false, error: `${k} not a string` };
  }
  // p_no_deal + close_estimate + offer_estimate are required for pipeline
  // rescans (per-buyer rescans may legitimately omit them, the AI focuses on
  // one buyer + echoes prior dashboard values).
  if (!onlyBuyerId) {
    if (typeof p.p_no_deal !== 'number' || p.p_no_deal < 0 || p.p_no_deal > 100) {
      return { ok: false, error: 'p_no_deal missing or out of range' };
    }
    if (typeof p.close_estimate !== 'string' || !/^\d{4}-\d{1,2}$/.test(p.close_estimate)) {
      return { ok: false, error: 'close_estimate missing or not YYYY-MM' };
    }
    if (p.offer_estimate != null && !/^\d{4}-\d{1,2}$/.test(String(p.offer_estimate))) {
      return { ok: false, error: 'offer_estimate not in YYYY-MM format' };
    }
  }
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
        global_intel: ws.global_intel || [],
        pinned_rules: ws.pinned_rules || [],
        lessons: ws.lessons || [],
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
  const { ebitda, case_mode, market, market_meta, rationales, process: proc, global_intel, pinned_rules, lessons } = req.body || {};
  try {
    await pool.query(`
      INSERT INTO workspace (id, ebitda, case_mode, market, market_meta, rationales, process, global_intel, pinned_rules, lessons, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
      ON CONFLICT (id) DO UPDATE SET
        ebitda = COALESCE(EXCLUDED.ebitda, workspace.ebitda),
        case_mode = COALESCE(EXCLUDED.case_mode, workspace.case_mode),
        market = COALESCE(EXCLUDED.market, workspace.market),
        market_meta = COALESCE(EXCLUDED.market_meta, workspace.market_meta),
        rationales = COALESCE(EXCLUDED.rationales, workspace.rationales),
        process = COALESCE(EXCLUDED.process, workspace.process),
        global_intel = COALESCE(EXCLUDED.global_intel, workspace.global_intel),
        pinned_rules = COALESCE(EXCLUDED.pinned_rules, workspace.pinned_rules),
        lessons = COALESCE(EXCLUDED.lessons, workspace.lessons),
        updated_at = now()
    `, [WORKSPACE_ID, ebitda ?? null, case_mode ?? null, market ?? null, market_meta ?? null, rationales ?? null, proc ?? null, global_intel ?? null, pinned_rules ?? null, lessons ?? null]);
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/workspace error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Bulk replace buyers. Only used on the initial-seed path when the server is
// empty and the client uploads its localStorage buyers. Everyday writes go
// through PATCH /api/buyers/:id below, which can't clobber buyers the caller
// hasn't seen and which preserves noteLog history via union-merge.
app.put('/api/buyers', async (req, res) => {
  if (!ensureDb(res)) return;
  const buyers = Array.isArray(req.body?.buyers) ? req.body.buyers : null;
  if (!buyers) return res.status(400).json({ error: 'buyers array required' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Identity fields are set by server-side migrations (BI Top 100 rank, PE
    // backing, sponsor). A stale client that loaded before the migration ran
    // would otherwise wipe them by sending null/missing values in this bulk
    // push. Read existing rows first, then for each incoming buyer fill in
    // any identity field the client doesn't have using the server's value.
    const existingRows = await c.query(
      `SELECT id, data FROM buyers WHERE workspace_id = $1`, [WORKSPACE_ID]
    );
    const existingById = Object.fromEntries(existingRows.rows.map(r => [r.id, r.data || {}]));
    await c.query(`DELETE FROM buyers WHERE workspace_id = $1`, [WORKSPACE_ID]);
    for (const b of buyers) {
      if (!b?.id) continue;
      const old = existingById[b.id] || {};
      const merged = { ...b };
      for (const k of IDENTITY_FIELDS) {
        if ((merged[k] == null || merged[k] === '') && old[k] != null && old[k] !== '') {
          merged[k] = old[k];
        }
      }
      await c.query(
        `INSERT INTO buyers (workspace_id, id, data) VALUES ($1, $2, $3)`,
        [WORKSPACE_ID, b.id, merged]
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

// Upsert a single buyer with two layers of stale-client protection:
//
// 1. noteLog is union-merged by entry id, so a stale browser can't drop a
//    recently-added note (e.g. chat-derived intel) on the next write.
// 2. PROCESS_FIELDS (stage, nda_signed, cim_delivered, chemistry_date,
//    ioi_received) are PRESERVED FROM THE SERVER COPY when the incoming
//    payload's `updated_at` is older than the server's current updated_at.
//    This is what prevents the failure mode that bit C&B: a startup
//    migration bumps the server stage, but the user's already-loaded
//    browser still holds the pre-migration stage in local state; when the
//    next rescan triggers a PATCH, the stale stage no longer overwrites
//    the migration's correction.
//
// The server's authoritative copy of the buyer is returned in the response
// so the client can sync its local state without a full workspace refetch.
app.patch('/api/buyers/:id', async (req, res) => {
  if (!ensureDb(res)) return;
  const { id } = req.params;
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || incoming.id !== id) {
    return res.status(400).json({ error: 'buyer payload missing or id mismatch' });
  }
  const PROCESS_FIELDS = ['stage', 'nda_signed', 'cim_delivered', 'chemistry_date', 'ioi_received'];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const existing = await c.query(
      `SELECT data, updated_at FROM buyers WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [WORKSPACE_ID, id]
    );
    let merged = incoming;
    let staleClient = false;
    if (existing.rowCount > 0) {
      const old = existing.rows[0].data || {};
      const serverUpdatedAt = existing.rows[0].updated_at ? new Date(existing.rows[0].updated_at) : null;
      const clientUpdatedAt = incoming.updated_at ? new Date(incoming.updated_at) : null;
      // 10-minute staleness window. Previous "any-server-write-newer = stale"
      // rule reverted every PATCH after the first one in a session because
      // the server bumps updated_at on every write while the client's local
      // updated_at stays from initial fetch. Chat tool calls (set_buyer_stage,
      // etc.) got silently reverted as a result. The window catches the real
      // failure mode (user idle for many minutes while a migration changes
      // the server) without nuking legitimate user intent.
      const STALENESS_THRESHOLD_MS = 10 * 60 * 1000;
      staleClient = !!(serverUpdatedAt && clientUpdatedAt
        && (serverUpdatedAt.getTime() - clientUpdatedAt.getTime()) > STALENESS_THRESHOLD_MS);

      const oldLog = Array.isArray(old.noteLog) ? old.noteLog : [];
      const newLog = Array.isArray(incoming.noteLog) ? incoming.noteLog : [];
      const incomingIds = new Set(newLog.map(n => n?.id).filter(Boolean));
      const retained = oldLog.filter(n => n?.id && !incomingIds.has(n.id));
      merged = { ...incoming, noteLog: [...newLog, ...retained] };

      if (staleClient) {
        for (const k of PROCESS_FIELDS) {
          if (k in old) merged[k] = old[k];
          else delete merged[k];
        }
      }

      // Identity-field preservation (unconditional, not gated on staleness).
      // The previous bug: a startup migration sets Scott's top100_rank=55,
      // the client (which loaded before the migration) syncs without the
      // field, and PATCH wipes it. Identity fields are server-of-record;
      // only an explicit client value (non-null, non-empty) overrides.
      for (const k of IDENTITY_FIELDS) {
        if ((merged[k] == null || merged[k] === '') && old[k] != null && old[k] !== '') {
          merged[k] = old[k];
        }
      }
    }
    const writeRes = await c.query(
      `INSERT INTO buyers (workspace_id, id, data, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (workspace_id, id) DO UPDATE SET
         data = EXCLUDED.data, updated_at = now()
       RETURNING data, updated_at`,
      [WORKSPACE_ID, id, merged]
    );
    await c.query('COMMIT');
    const row = writeRes.rows[0];
    res.json({ ok: true, stale_client: staleClient, buyer: { ...row.data, updated_at: row.updated_at } });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('PATCH /api/buyers/:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    c.release();
  }
});

// Explicit per-buyer deletion. Deletes only the named buyer — stale browsers
// can no longer drop buyers by sending an array that's missing some entries.
app.delete('/api/buyers/:id', async (req, res) => {
  if (!ensureDb(res)) return;
  const { id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM buyers WHERE workspace_id = $1 AND id = $2`,
      [WORKSPACE_ID, id]
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch (err) {
    console.error('DELETE /api/buyers/:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Explicit per-note deletion. The PATCH endpoint union-merges noteLog (so
// stale browsers can't drop notes they never saw), which means a deletion
// from the UI doesn't propagate via PATCH. This route does propagate it:
// the note id is removed from the buyer's stored noteLog.
app.delete('/api/buyers/:id/notes/:noteId', async (req, res) => {
  if (!ensureDb(res)) return;
  const { id, noteId } = req.params;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const existing = await c.query(
      `SELECT data FROM buyers WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [WORKSPACE_ID, id]
    );
    if (existing.rowCount === 0) {
      await c.query('COMMIT');
      return res.json({ ok: true, removed: 0 });
    }
    const b = { ...existing.rows[0].data };
    const before = Array.isArray(b.noteLog) ? b.noteLog.length : 0;
    b.noteLog = (Array.isArray(b.noteLog) ? b.noteLog : []).filter(e => e?.id !== noteId);
    const removed = before - b.noteLog.length;
    if (removed > 0) {
      await c.query(
        `UPDATE buyers SET data = $1, updated_at = now() WHERE workspace_id = $2 AND id = $3`,
        [b, WORKSPACE_ID, id]
      );
    }
    await c.query('COMMIT');
    res.json({ ok: true, removed });
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/buyers/:id/notes/:noteId error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    c.release();
  }
});

// Paginated AI audit log, newest first. Each row is a single rescan call.
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

  const sys = `You are classifying documents in the Kennion Prediction Engine, a deal-tracking workspace for the sale of Kennion's Benefits Program. The user just uploaded a document. Read it and return ONLY a JSON object, no markdown, no commentary, with this exact shape:
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

// Manual re-trigger for the repair migration. Normally runs once at server
// startup via runStartupMigrations; this endpoint lets us re-apply it without
// a redeploy. force=1 also clears the applied_migrations row so it runs again
// at the next startup.
app.post('/api/admin/repair-state', async (req, res) => {
  if (!ensureDb(res)) return;
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    if (force) {
      await pool.query(`DELETE FROM applied_migrations WHERE id = $1`, ['repair_state_2026_05_15']);
    }
    const summary = await repairStateMigration();
    await pool.query(
      `INSERT INTO applied_migrations (id, summary) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary, applied_at = now()`,
      ['repair_state_2026_05_15', summary]
    );
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('POST /api/admin/repair-state error:', err.message);
    res.status(500).json({ error: err.message });
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
