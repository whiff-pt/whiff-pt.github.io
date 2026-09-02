#!/usr/bin/env node
/**
 * Fit the model's two free constants to your own observations.
 *
 * Feed it the CSV exported from the web app's "Did you actually smell it?"
 * panel. It re-derives each night's exposure index from the logged factors,
 * then grid-searches e50 and k for the maximum-likelihood fit and reports how
 * much better the result is than the current defaults.
 *
 *   node notifier/calibrate.mjs whiff-log.csv
 *
 * Thirty-odd nights spanning both smelly and clean conditions is roughly the
 * minimum worth fitting. Below that, leave the defaults alone.
 */

import { readFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';
import { DEFAULTS, clamp } from '../src/model.js';

const path = argv[2];
if (!path) {
  console.error('Usage: node notifier/calibrate.mjs <whiff-log.csv>');
  exit(1);
}

const rows = parseCsv(await readFile(path, 'utf8'));
if (!rows.length) {
  console.error('No rows in that CSV.');
  exit(1);
}

// The app logs the predicted probability under the defaults in force at the
// time; invert the logistic to recover the exposure index it came from.
const samples = rows
  .map((r) => {
    const p = clamp(Number(r.predicted), 1e-4, 1 - 1e-4);
    const z = Math.log(p / (1 - p));
    return {
      logE: z * DEFAULTS.k + Math.log(DEFAULTS.e50),
      smelled: Number(r.smell) >= 1 ? 1 : 0,
      night: r.night,
    };
  })
  .filter((s) => Number.isFinite(s.logE));

const positives = samples.filter((s) => s.smelled).length;
console.log(`${samples.length} nights logged — ${positives} with odor, ${samples.length - positives} without.`);
if (positives === 0 || positives === samples.length) {
  console.error('Every night has the same outcome; there is nothing to fit yet.');
  exit(1);
}
if (samples.length < 20) console.error('Warning: fewer than 20 nights. Treat the fit as provisional.\n');

const logLik = (e50, k) => samples.reduce((sum, s) => {
  const p = clamp(1 / (1 + Math.exp(-(s.logE - Math.log(e50)) / k)), 1e-6, 1 - 1e-6);
  return sum + (s.smelled ? Math.log(p) : Math.log(1 - p));
}, 0);

let best = { e50: DEFAULTS.e50, k: DEFAULTS.k, ll: -Infinity };
for (let i = 0; i <= 120; i += 1) {
  const e50 = 0.02 * Math.exp((i / 120) * Math.log(150)); // 0.02 … 3.0, log-spaced
  for (let j = 0; j <= 60; j += 1) {
    const k = 0.3 + (j / 60) * 1.7; // 0.3 … 2.0
    const ll = logLik(e50, k);
    if (ll > best.ll) best = { e50, k, ll };
  }
}

const baseLl = logLik(DEFAULTS.e50, DEFAULTS.k);
const brier = (e50, k) => samples.reduce((sum, s) => {
  const p = 1 / (1 + Math.exp(-(s.logE - Math.log(e50)) / k));
  return sum + (p - s.smelled) ** 2;
}, 0) / samples.length;

console.log(`\ncurrent  e50=${DEFAULTS.e50.toFixed(3)}  k=${DEFAULTS.k.toFixed(2)}` +
            `   logLik ${baseLl.toFixed(2)}   Brier ${brier(DEFAULTS.e50, DEFAULTS.k).toFixed(4)}`);
console.log(`fitted   e50=${best.e50.toFixed(3)}  k=${best.k.toFixed(2)}` +
            `   logLik ${best.ll.toFixed(2)}   Brier ${brier(best.e50, best.k).toFixed(4)}`);

const gain = best.ll - baseLl;
console.log(
  gain < 1.0
    ? '\nThe fit is barely better than the defaults — keep them.'
    : `\nEdit DEFAULTS in src/model.js:\n  e50: ${best.e50.toFixed(3)},\n  k: ${best.k.toFixed(2)},`,
);

// Reliability table: how often did odor actually occur in each forecast bucket?
console.log('\nReliability under the fitted constants:');
const buckets = [[0, .2], [.2, .4], [.4, .6], [.6, .8], [.8, 1.01]];
for (const [lo, hi] of buckets) {
  const inBucket = samples.filter((s) => {
    const p = 1 / (1 + Math.exp(-(s.logE - Math.log(best.e50)) / best.k));
    return p >= lo && p < hi;
  });
  if (!inBucket.length) continue;
  const rate = inBucket.filter((s) => s.smelled).length / inBucket.length;
  console.log(`  forecast ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%: ` +
              `observed ${(rate * 100).toFixed(0)}% over ${inBucket.length} night(s)`);
}

function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(',');
  return lines.filter(Boolean).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}
