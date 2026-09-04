#!/usr/bin/env node
/**
 * Whiff notifier — the part that actually reaches your phone.
 *
 * Run it once each afternoon (cron, Windows Task Scheduler, or the bundled
 * GitHub Action). It scores tonight for every configured address and pushes a
 * notification when the chance clears that address's threshold.
 *
 *   node notifier/notify.mjs [--config notifier/config.json] [--dry-run] [--force]
 *
 * Requires Node 18+ (global fetch). No dependencies.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { argv, env, exit } from 'node:process';
import { siteGeometry, buildNights, currentNightKey, explain, compass } from '../src/model.js';
import { fmtSpeed, fmtHour12 } from '../src/units.js';
import { fetchWeather, nowInPT } from '../src/weather.js';

const args = parseArgs(argv.slice(2));

// CI runners keep the whole config in one secret; local runs use a file.
const config = env.WHIFF_CONFIG_JSON
  ? JSON.parse(env.WHIFF_CONFIG_JSON)
  : await loadConfigFile(args.config ?? fileURLToPath(new URL('./config.json', import.meta.url)));

async function loadConfigFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    console.error(`Cannot read config at ${path}: ${e.message}`);
    console.error('Copy notifier/config.example.json to notifier/config.json and edit it,');
    console.error('or set WHIFF_CONFIG_JSON to the config as a JSON string.');
    exit(1);
  }
}

const nightStartHour = config.nightStartHour ?? 19;
const nightEndHour = config.nightEndHour ?? 7;
const opts = { nightStartHour, nightEndHour };

const wx = await fetchWeather({ days: 2, model: config.model ?? 'best_match' });
const now = nowInPT();
const tonightKey = currentNightKey(now, opts);

let sent = 0;
for (const sub of config.subscribers ?? []) {
  const geo = siteGeometry({ lat: sub.lat, lon: sub.lon, elevationM: sub.elevationM });
  const nights = buildNights(wx.hourly, geo, opts);
  const tonight = nights.find((n) => n.key === tonightKey) ?? nights[0];
  if (!tonight) {
    console.error(`No forecast hours for tonight (${tonightKey}) — skipping ${sub.label}.`);
    continue;
  }

  const pct = Math.round(tonight.p * 100);
  const threshold = sub.threshold ?? 50;
  const over = pct >= threshold;
  console.log(
    `${sub.label}: ${pct}% (threshold ${threshold}%) — peak ${tonight.peak.hour.iso}, ` +
    `${compass(tonight.peak.factors.windDir)} @ ${fmtSpeed(tonight.peak.factors.ws)}`,
  );

  if (!over && !args.force) continue;

  const title = `👃 ${pct}% chance of mill odor tonight`;
  const reasons = explain(tonight, geo).filter((r) => !r.good).map((r) => `• ${r.text}`);
  const body = [
    `${tonight.level.label} at ${sub.label}.`,
    `Worst around ${fmtHour(tonight.peak.hour.iso)} (${Math.round(tonight.peak.p * 100)}% that hour).`,
    '',
    ...reasons,
  ].join('\n');

  sent += 1;
  if (args['dry-run']) {
    console.log(`--- dry run ---\n${title}\n${body}\n`);
    continue;
  }
  await deliver(sub, { title, body, pct, tonight });
}

const verb = args['dry-run'] ? 'Would send' : 'Sent';
console.log(sent ? `${verb} ${sent} notification(s).` : 'Nothing over threshold.');

// ---------------------------------------------------------------------------

async function deliver(sub, msg) {
  const jobs = [];

  // ntfy.sh: free, no account, works on iOS and Android. Subscribe your phone
  // to the same topic string. Pick something unguessable — topics are public.
  const topic = sub.ntfyTopic ?? config.ntfyTopic;
  if (topic) {
    const server = config.ntfyServer ?? 'https://ntfy.sh';
    jobs.push(post(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: {
        Title: msg.title,
        Priority: msg.pct >= 75 ? 'high' : 'default',
        Tags: 'nose,factory',
        ...(config.ntfyToken ? { Authorization: `Bearer ${config.ntfyToken}` } : {}),
      },
      body: msg.body,
    }, 'ntfy'));
  }

  // Any generic JSON webhook (Slack, Discord, Home Assistant, IFTTT, …).
  const hook = sub.webhook ?? config.webhook;
  if (hook) {
    jobs.push(post(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${msg.title}\n${msg.body}`,
        probability: msg.pct,
        night: msg.tonight.key,
        address: sub.label,
      }),
    }, 'webhook'));
  }

  if (!jobs.length) console.error(`No delivery channel configured for ${sub.label}.`);
  await Promise.all(jobs);
}

async function post(url, init, name) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) console.error(`${name} failed: ${res.status} ${await res.text()}`);
    else console.log(`  → ${name} delivered`);
  } catch (e) {
    console.error(`${name} error: ${e.message}`);
  }
}

function fmtHour(iso) {
  return fmtHour12(Number(iso.slice(11, 13)));
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].startsWith('--')) continue;
    const key = list[i].slice(2);
    const next = list[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  if (env.WHIFF_CONFIG && !out.config) out.config = env.WHIFF_CONFIG;
  return out;
}
