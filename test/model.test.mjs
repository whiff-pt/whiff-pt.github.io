/* Sanity tests for the odor model: node --test test/ */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MILL, siteGeometry, scoreHour, scoreNight, buildNights, angDiff, compass, haversineKm,
} from '../src/model.js';

/** An address 3 km due north-east of the mill (roughly downtown Port Townsend). */
const downtown = siteGeometry({ lat: 48.1150, lon: -122.7690, elevationM: 20 });

function hour(overrides = {}) {
  return {
    time: new Date('2026-10-12T23:00'),
    iso: '2026-10-12T23:00',
    hourLocal: 23,
    temp2m: 9, temp1000: 8, temp925: 4,
    rh: 80, precip: 0, cloudCover: 40, visibility: 20000,
    windSpeed: 3, windDir: 0, gust: 5, blh: 500,
    ...overrides,
  };
}

/** Wind direction (FROM) that puts the given site exactly downwind. */
const downwindDir = (geo) => (geo.bearingFromMill + 180) % 360;

test('geometry: downtown is a few km NE of the mill', () => {
  assert.ok(downtown.distKm > 2 && downtown.distKm < 6, `got ${downtown.distKm}`);
  assert.ok(downtown.bearingFromMill > 20 && downtown.bearingFromMill < 80);
  assert.equal(haversineKm(MILL, MILL), 0);
});

test('angDiff wraps correctly', () => {
  assert.equal(angDiff(350, 10), 20);
  assert.equal(angDiff(10, 350), 20);
  assert.equal(angDiff(0, 180), 180);
  assert.equal(compass(0), 'N');
  assert.equal(compass(225), 'SW');
});

test('being downwind beats being crosswind beats being upwind', () => {
  const dw = downwindDir(downtown);
  const down = scoreHour(hour({ windDir: dw }), downtown).p;
  const cross = scoreHour(hour({ windDir: (dw + 90) % 360 }), downtown).p;
  const up = scoreHour(hour({ windDir: (dw + 180) % 360 }), downtown).p;
  assert.ok(down > cross, `${down} !> ${cross}`);
  assert.ok(cross > up || Math.abs(cross - up) < 1e-6);
  assert.ok(down > 0.4, `downwind should be a real risk, got ${down}`);
  assert.ok(up < 0.1, `upwind should be near zero, got ${up}`);
});

test('a strong surface inversion raises the odds', () => {
  const dw = downwindDir(downtown);
  const mixed = scoreHour(hour({ windDir: dw, temp1000: 6, temp925: 2, blh: 1200 }), downtown).p;
  const trapped = scoreHour(hour({ windDir: dw, temp1000: 12, temp925: 8, blh: 90 }), downtown).p;
  assert.ok(trapped > mixed, `${trapped} !> ${mixed}`);
});

test('fog raises the odds and rain lowers them', () => {
  const dw = downwindDir(downtown);
  const base = scoreHour(hour({ windDir: dw }), downtown).p;
  const foggy = scoreHour(hour({ windDir: dw, visibility: 600, rh: 99 }), downtown).p;
  const rainy = scoreHour(hour({ windDir: dw, precip: 4 }), downtown).p;
  assert.ok(foggy > base);
  assert.ok(rainy < base);
});

test('a gale disperses the plume even when you are downwind', () => {
  const dw = downwindDir(downtown);
  const breeze = scoreHour(hour({ windDir: dw, windSpeed: 2.5 }), downtown).p;
  const gale = scoreHour(hour({ windDir: dw, windSpeed: 14, blh: 1400, temp1000: 6 }), downtown).p;
  assert.ok(gale < breeze * 0.6, `${gale} not much lower than ${breeze}`);
});

test('near-calm gives a nonzero baseline regardless of nominal wind direction', () => {
  const up = (downwindDir(downtown) + 180) % 360;
  const calm = scoreHour(hour({ windDir: up, windSpeed: 0.2, blh: 80, temp1000: 12, rh: 97 }), downtown).p;
  assert.ok(calm > 0.25, `calm stagnant night should not read as safe, got ${calm}`);
});

test('probability decays with distance', () => {
  const dw = downwindDir(downtown);
  const far = siteGeometry({ lat: 48.1150, lon: -122.7690, elevationM: 20 });
  const near = { ...far, distKm: 1 };
  const veryFar = { ...far, distKm: 20 };
  assert.ok(
    scoreHour(hour({ windDir: dw }), near).p > scoreHour(hour({ windDir: dw }), veryFar).p,
  );
});

test('a night aggregates above its worst single hour but stays bounded', () => {
  const dw = downwindDir(downtown);
  const hours = [20, 21, 22, 23, 0, 1, 2, 3].map((hl) =>
    hour({ hourLocal: hl, windDir: dw, time: new Date(`2026-10-12T${String(hl).padStart(2, '0')}:00`) }));
  const night = scoreNight(hours, downtown);
  const worst = Math.max(...hours.map((h) => scoreHour(h, downtown).p));
  assert.ok(night.p >= worst, `${night.p} < ${worst}`);
  assert.ok(night.p <= 0.93);
  assert.equal(night.hours.length, 8);
});

/**
 * Regression anchor — the only observed odor event this model has been checked
 * against. Night of 31 Aug 2026 at 1313 Logan St (1.7 km due north of the
 * mill), reported as the worst of the season. Resident confirms the smell
 * arrived AFTER MIDNIGHT, not during the evening. Values below are the
 * archived Open-Meteo hourly forecast at the mill.
 *
 * That timing is the whole point of the test. The nominal 10 m wind was WNW
 * all night — over 110° off-axis, i.e. pointing the plume away from Logan St —
 * so a direction-driven model sees nothing. But after 01:00 the wind fell below
 * 2 m/s while the boundary layer collapsed to 35-80 m under a +1 to +2.3 C
 * inversion with RH reaching 94%. The first version of this model scored those
 * hours at 2% and got its entire night-level score from a single 06:00 wind
 * shift: right answer, wrong mechanism. Under a boundary layer that shallow, at
 * 1-2 m/s, the 10 m wind direction is not a signal at all.
 *
 * One night is one data point. Do not retune e50/k against it.
 */
const AUG31 = [
  // iso,                windDir, ws,   blh, t2m,  t1000, t925, rh, cloud, precip, vis
  ['2026-08-31T19:00', 288, 2.62, 345, 19.6, 19.1, 16.8, 62, 72, 0, 28000],
  ['2026-08-31T20:00', 298, 2.73, 185, 18.6, 19.2, 16.7, 57, 15, 0, 32100],
  ['2026-08-31T21:00', 301, 3.50, 130, 15.8, 17.4, 16.2, 71, 15, 0, 22500],
  ['2026-08-31T22:00', 295, 4.07, 195, 15.1, 16.4, 16.3, 69, 2, 0, 23300],
  ['2026-08-31T23:00', 288, 3.57, 205, 15.5, 16.3, 16.4, 61, 4, 0, 28600],
  ['2026-09-01T00:00', 295, 4.07, 200, 14.5, 15.8, 16.5, 73, 3, 0, 21200],
  ['2026-09-01T01:00', 293, 2.82, 210, 13.8, 14.7, 16.3, 82, 5, 0, 16700],
  ['2026-09-01T02:00', 297, 1.57, 45, 12.9, 13.9, 15.5, 88, 2, 0, 14600],
  ['2026-09-01T03:00', 307, 1.50, 80, 12.5, 13.4, 15.1, 91, 9, 0, 13600],
  ['2026-09-01T04:00', 3, 1.70, 55, 11.9, 13.0, 14.9, 93, 5, 0, 13000],
  ['2026-09-01T05:00', 297, 0.89, 55, 11.1, 12.8, 14.8, 93, 27, 0, 12200],
  ['2026-09-01T06:00', 164, 1.77, 35, 10.7, 13.0, 14.1, 94, 50, 0, 12200],
].map(([iso, windDir, windSpeed, blh, temp2m, temp1000, temp925, rh, cloudCover, precip, visibility]) => ({
  time: new Date(iso),
  iso,
  hourLocal: Number(iso.slice(11, 13)),
  windDir, windSpeed, blh, temp2m, temp1000, temp925, rh, cloudCover, precip, visibility,
  gust: windSpeed * 1.6,
  dewPoint: temp2m - 1,
}));

test('31 Aug 2026: decoupled small hours are not dismissed as upwind', () => {
  const logan = siteGeometry({ lat: 48.1095476, lon: -122.7983463, elevationM: 77 });
  const byHour = Object.fromEntries(AUG31.map((h) => [h.hourLocal, scoreHour(h, logan)]));

  // Every hour up to 05:00 is 110-174 deg off-axis, so alignment alone is ~0.
  for (const hl of [19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5]) {
    assert.ok(byHour[hl].factors.offAxisDeg > 100, `hour ${hl} should be off-axis`);
  }
  // At 06:00 the wind swung to SSE and put Logan St squarely downwind.
  assert.ok(byHour[6].factors.offAxisDeg < 25);

  // Windy evening hours under a 130-345 m layer stay coupled, and stay low.
  for (const hl of [19, 20, 21, 22, 23, 0, 1]) {
    assert.ok(byHour[hl].p < 0.1, `evening hour ${hl} should stay low, got ${byHour[hl].p}`);
  }

  // The 02:00-05:00 hours are light-wind under a 45-80 m layer: decoupled, so
  // they must not be dismissed just because the nominal direction points away.
  for (const hl of [2, 3, 4, 5]) {
    assert.ok(byHour[hl].factors.decoupled > 0.25, `hour ${hl} should read as decoupled`);
    assert.ok(byHour[hl].p > 0.15, `hour ${hl} should carry real weight, got ${byHour[hl].p}`);
  }

  // And the night as a whole should land in the top band.
  assert.ok(scoreNight(AUG31, logan).p > 0.6, 'the worst night of the season should score high');
});

test('buildNights groups after-midnight hours with the previous evening', () => {
  const hours = [];
  for (let d = 12; d <= 13; d += 1) {
    for (let hl = 0; hl < 24; hl += 1) {
      const iso = `2026-10-${d}T${String(hl).padStart(2, '0')}:00`;
      hours.push(hour({ hourLocal: hl, time: new Date(iso), iso }));
    }
  }
  const nights = buildNights(hours, downtown);
  // The 12th's small hours belong to the night that began on the 11th.
  assert.deepEqual(nights.map((n) => n.key), ['2026-10-11', '2026-10-12', '2026-10-13']);
  assert.equal(nights[0].hours.length, 7); //  00:00-06:00 only
  assert.equal(nights[1].hours.length, 12); // 19:00-23:00 plus 00:00-06:00
  assert.equal(nights[2].hours.length, 5); //  19:00-23:00 only
  assert.ok(nights.every((n) => n.p > 0 && n.p < 1));
});
