#!/usr/bin/env node
/**
 * Download the shared observation log and write it as CSV for calibrate.mjs.
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=eyJ... \
 *   node notifier/pull-observations.mjs > observations.csv
 *
 * Needs the SERVICE_ROLE key, not the anon key — the anon key deliberately has
 * no read access. Keep it in your shell or a .env file, never in the repo, and
 * never in src/share-config.js.
 *
 * Progress and warnings go to stderr so the CSV on stdout stays clean.
 */

import { env, exit, stdout, stderr } from 'node:process';

const url = env.SUPABASE_URL?.replace(/\/$/, '');
const key = env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  stderr.write('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.\n');
  exit(1);
}

const COLS = [
  'night', 'smell', 'smell_window', 'dist_km', 'bearing_deg', 'elevation_m',
  'predicted', 'peak_hour', 'wind_dir', 'wind_speed', 'alignment', 'stability',
  'moisture', 'decoupled', 'model_version', 'submitted_at',
];

// install_id is fetched for the per-contributor summary but never written to
// the CSV: the dataset should not carry a key that links one person's nights.
const rows = await page(`${url}/rest/v1/observations?select=install_id,${COLS.join(',')}&order=night.asc`);

if (!rows.length) {
  stderr.write('No observations yet.\n');
  exit(0);
}

stdout.write(`${COLS.join(',')}\n`);
for (const r of rows) stdout.write(`${COLS.map((c) => csv(r[c])).join(',')}\n`);

// --- summary to stderr -----------------------------------------------------
const contributors = new Set(rows.map((r) => r.install_id)).size;
const smelly = rows.filter((r) => r.smell >= 1).length;
const withWindow = rows.filter((r) => r.smell >= 1 && r.smell_window).length;
const versions = [...new Set(rows.map((r) => r.model_version))];

stderr.write(`\n${rows.length} observations from ${contributors} contributor(s)\n`);
stderr.write(`  ${smelly} smelly, ${rows.length - smelly} clean\n`);
stderr.write(`  ${withWindow} of the ${smelly} smelly nights have a time band\n`);
stderr.write(`  model versions: ${versions.join(', ')}\n`);

if (versions.length > 1) {
  stderr.write('\n  WARNING: mixed model versions. Probabilities from different\n' +
               '  versions are not comparable — filter before fitting.\n');
}
if (smelly === 0 || smelly === rows.length) {
  stderr.write('\n  WARNING: every night has the same outcome. Nothing to fit yet;\n' +
               '  clean nights are what constrain the false-positive rate.\n');
} else if (rows.length < 30) {
  stderr.write(`\n  ${rows.length} rows is below the ~30 worth fitting. Keep collecting.\n`);
}

// Time-band breakdown: the column the 31 Aug event proved was load-bearing.
const bands = {};
for (const r of rows.filter((x) => x.smell_window)) {
  bands[r.smell_window] = (bands[r.smell_window] ?? 0) + 1;
}
if (Object.keys(bands).length) {
  stderr.write(`  timing: ${Object.entries(bands).map(([k, v]) => `${k} ${v}`).join(', ')}\n`);
}
stderr.write('\n');

// ---------------------------------------------------------------------------

/** PostgREST caps a response at 1000 rows by default; walk it with Range. */
async function page(endpoint) {
  const out = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const res = await fetch(endpoint, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Range: `${from}-${from + size - 1}`,
      },
    });
    if (!res.ok) {
      stderr.write(`Supabase returned ${res.status}: ${await res.text()}\n`);
      exit(1);
    }
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < size) return out;
  }
}

function csv(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
