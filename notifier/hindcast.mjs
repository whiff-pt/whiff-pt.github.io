#!/usr/bin/env node
/**
 * Score a night that has already happened, so you can check the model against
 * a night you remember. Prints the hour-by-hour breakdown plus the surrounding
 * nights, because the useful question is rarely "what number did it give?" but
 * "did it rank the bad night above the ordinary ones?".
 *
 *   node notifier/hindcast.mjs --date 2026-08-31 --address "1313 Logan St"
 *   node notifier/hindcast.mjs --date 2026-08-31 --lat 48.1095 --lon -122.7983
 *
 * Add --context 3 to score three nights either side.
 */

import { argv, exit } from 'node:process';
import { siteGeometry, buildNights, scoreHour, explain, compass, MILL } from '../src/model.js';
import { fmtDistance, fmtSpeed, fmtElevation, fmtHour12, fmtTemp } from '../src/units.js';
import { fetchHistory, fetchElevation, geocode } from '../src/weather.js';

const args = parseArgs(argv.slice(2));
if (!args.date) {
  console.error('Usage: node notifier/hindcast.mjs --date YYYY-MM-DD (--address "..." | --lat N --lon N)');
  exit(1);
}

// --- resolve the address --------------------------------------------------
let site;
if (args.lat && args.lon) {
  site = { lat: Number(args.lat), lon: Number(args.lon), label: args.label ?? 'given coordinates' };
} else if (args.address) {
  const hits = await geocode(args.address);
  if (!hits.length) { console.error(`No geocoder match for "${args.address}".`); exit(1); }
  site = { lat: hits[0].lat, lon: hits[0].lon, label: hits[0].label };
} else {
  console.error('Give either --address or --lat/--lon.');
  exit(1);
}
site.elevationM = args.elevation ? Number(args.elevation) : (await fetchElevation(site.lat, site.lon) ?? 20);

const geo = siteGeometry(site);

// --- fetch a window around the night --------------------------------------
const context = Number(args.context ?? 3);
const target = new Date(`${args.date}T12:00`);
const start = shiftDays(target, -context);
const end = shiftDays(target, context + 1); // +1 so the final night has its morning
const wx = await fetchHistory(iso(start), iso(end));

const nights = buildNights(wx.hourly, geo, {});
const night = nights.find((n) => n.key === args.date);
if (!night) {
  console.error(`No hours returned for the night of ${args.date}. Archive coverage may lag by a day or two.`);
  exit(1);
}

// --- report ---------------------------------------------------------------
const pct = (p) => `${Math.round(p * 100)}%`;

console.log(`\n  ${site.label}`);
console.log(`  ${fmtDistance(geo.distKm)} ${compass(geo.bearingFromMill)} of the mill ` +
            `(bearing ${Math.round(geo.bearingFromMill)}°), ${fmtElevation(geo.elevationM)} elevation`);
console.log(`  Archive: Open-Meteo historical forecast, grid ${wx.grid.lat.toFixed(3)}, ${wx.grid.lon.toFixed(3)}\n`);

console.log(`  NIGHT OF ${args.date}:  ${pct(night.p)}  — ${night.level.label}\n`);

console.log('   hour chance   dir   speed  offaxis    align  stab  moist     BLH   T2  T110m      inv   RH%');
console.log('  ' + '-'.repeat(92));
for (const s of night.hours) {
  const h = s.hour;
  const inv = Number.isFinite(h.temp1000) ? h.temp1000 - h.temp2m : NaN;
  console.log(
    `  ${fmtHour12(Number(h.iso.slice(11, 13))).padStart(5)}  ${pct(s.p).padStart(5)}   ` +
    `${compass(h.windDir).padEnd(3)} ${fmtSpeed(h.windSpeed).padStart(7)}  ` +
    `${String(Math.round(s.factors.offAxisDeg)).padStart(6)}°  ` +
    `${s.factors.alignment.toFixed(2).padStart(5)}  ` +
    `${s.factors.stability.toFixed(2).padStart(4)}  ` +
    `${s.factors.moisture.toFixed(2).padStart(5)}  ` +
    `${(Math.round(h.blh * 3.28084) + ' ft').padStart(6)}  ` +
    `${fmtTemp(h.temp2m).padStart(5)}  ${fmtTemp(h.temp1000).padStart(5)}  ` +
    `${((inv >= 0 ? '+' : '') + (inv * 9 / 5).toFixed(1) + '°F').padStart(7)}  ` +
    `${String(Math.round(h.rh)).padStart(3)}%`,
  );
}

console.log('\n  Why:');
for (const r of explain(night, geo)) console.log(`    ${r.good ? '▼' : '▲'} ${r.text}`);

console.log('\n  Surrounding nights, same address:');
for (const n of nights) {
  const mark = n.key === args.date ? ' ←' : '';
  const bar = '█'.repeat(Math.round(n.p * 30));
  console.log(`    ${n.key}  ${pct(n.p).padStart(4)}  ${bar}${mark}`);
}

const rank = [...nights].sort((a, b) => b.p - a.p).findIndex((n) => n.key === args.date) + 1;
console.log(`\n  Ranked ${rank} of ${nights.length} nights in this window.\n`);

// -------------------------------------------------------------------------
function iso(d) { return d.toISOString().slice(0, 10); }
function shiftDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    if (!list[i].startsWith('--')) continue;
    const key = list[i].slice(2);
    const next = list[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else out[key] = true;
  }
  return out;
}
