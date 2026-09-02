#!/usr/bin/env node
/**
 * Calibration aid: score the next few nights for a spread of neighbourhoods
 * around the mill and print a grid. Use it to check that the model still
 * discriminates — if every cell reads 90%+ or every cell reads 5%, retune
 * DEFAULTS.e50 / DEFAULTS.k in src/model.js.
 *
 *   node notifier/sweep.mjs
 */

import { siteGeometry, buildNights, compass } from '../src/model.js';
import { fetchWeather } from '../src/weather.js';

const PLACES = [
  ['Downtown / Water St', 48.1128, -122.7605, 8],
  ['Uptown', 48.1155, -122.7695, 33],
  ['North Beach', 48.1305, -122.7770, 12],
  ['Castle Hill', 48.1075, -122.7840, 60],
  ['Hastings Ave W', 48.1120, -122.8150, 45],
  ['Cape George', 48.1042, -122.8556, 15],
  ['Glen Cove (next door)', 48.0975, -122.8005, 10],
  ['Kala Point', 48.0670, -122.7830, 20],
  ['Port Hadlock', 48.0330, -122.7570, 15],
  ['Marrowstone', 48.0450, -122.6900, 10],
  ['Chimacum', 47.9970, -122.7780, 30],
  ['Fort Worden', 48.1400, -122.7660, 25],
];

const wx = await fetchWeather({ days: 5 });
const rows = PLACES.map(([label, lat, lon, elevationM]) => {
  const geo = siteGeometry({ lat, lon, elevationM });
  const nights = buildNights(wx.hourly, geo, {}).slice(0, 5);
  return { label, geo, nights };
});

const nightKeys = rows[0].nights.map((n) => n.key.slice(5));
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nMill-odor probability, ${wx.model}\n`);
console.log(pad('Neighbourhood', 24) + pad('km/dir', 12) + nightKeys.map((k) => pad(k, 8)).join(''));
console.log('-'.repeat(24 + 12 + nightKeys.length * 8));

for (const r of rows) {
  console.log(
    pad(r.label, 24) +
    pad(`${r.geo.distKm.toFixed(1)} ${compass(r.geo.bearingFromMill)}`, 12) +
    r.nights.map((n) => pad(`${Math.round(n.p * 100)}%`, 8)).join(''),
  );
}

const all = rows.flatMap((r) => r.nights.map((n) => n.p));
const mean = all.reduce((a, b) => a + b, 0) / all.length;
const atCap = all.filter((p) => p >= 0.925).length;
const atFloor = all.filter((p) => p <= 0.025).length;
console.log(
  `\n${all.length} cells · mean ${(mean * 100).toFixed(0)}% · ` +
  `${atCap} pinned at the ceiling · ${atFloor} at the floor\n`,
);

// Also show tonight's driving weather so the numbers can be sanity-checked.
console.log("Tonight's hours at the mill:");
for (const h of rows[0].nights[0].hours) {
  console.log(
    `  ${h.hour.iso.slice(11, 16)}  ${pad(compass(h.hour.windDir), 4)}` +
    `${h.hour.windSpeed.toFixed(1).padStart(5)} m/s   RH ${String(Math.round(h.hour.rh)).padStart(3)}%` +
    `   BLH ${String(Math.round(h.hour.blh)).padStart(5)} m` +
    `   T2 ${h.hour.temp2m.toFixed(1)}  T1000 ${h.hour.temp1000.toFixed(1)}`,
  );
}
