/**
 * Whiff — odor-exposure model for the Port Townsend Paper Co. mill.
 *
 * Pure ES module: no DOM, no network. Imported by both the browser app and the
 * Node notifier so the two can never disagree about a forecast.
 *
 * The model is a physically-motivated heuristic, NOT a statistical fit to
 * observed odor reports. See README "Calibration" before trusting the numbers.
 */

import { fmtDistance, fmtSpeed } from './units.js';

/** Washington Dept. of Ecology facility record for PORT TOWNSEND PAPER, 100 Mill Rd. */
export const MILL = {
  lat: 48.094076,
  lon: -122.796979,
  name: 'Port Townsend Paper Co.',
};

/**
 * Bumped whenever a change would alter the probability for identical weather.
 * Stamped onto every observation so calibration never mixes model generations.
 */
export const MODEL_VERSION = '0.2.0';

export const DEFAULTS = {
  nightStartHour: 19, // 7pm local
  nightEndHour: 7, //    7am local next day
  // The two knobs worth retuning once you have real observations. e50 is the
  // exposure index that maps to a 50% chance; k is the logistic width in
  // log-exposure space. See notifier/calibrate.mjs.
  e50: 0.35,
  k: 0.8,
  pMin: 0.02,
  pMax: 0.93, //         forecasts are never certain; don't pretend otherwise
  hourDecay: 0.35, //    correlation damping when combining hours in one night
};

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/** Great-circle distance in km. */
export function haversineKm(a, b) {
  const R = 6371.0088;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Initial bearing a -> b, degrees clockwise from true north. */
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest absolute difference between two compass bearings, 0..180. */
export function angDiff(a, b) {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

/**
 * Site geometry, computed once per address.
 * @param {{lat:number, lon:number, elevationM?:number}} site
 */
export function siteGeometry(site) {
  const distKm = haversineKm(MILL, site);
  return {
    distKm,
    // Bearing FROM the mill TO the address: the plume must travel this way.
    bearingFromMill: bearingDeg(MILL, site),
    elevationM: Number.isFinite(site.elevationM) ? site.elevationM : 20,
  };
}

// ---------------------------------------------------------------------------
// Per-hour scoring
// ---------------------------------------------------------------------------

/**
 * Score one forecast hour.
 *
 * @param {object} h  normalized hour: {hourLocal, windSpeed (m/s), windDir (deg FROM),
 *   temp2m, temp1000, temp925, rh, precip, cloudCover, visibility (m), blh (m)}
 * @param {object} geo result of siteGeometry()
 * @param {object} [opts]
 * @returns {{p:number, factors:object}}
 */
export function scoreHour(h, geo, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ws = Math.max(0, num(h.windSpeed, 2));
  const isNight = h.hourLocal >= o.nightStartHour || h.hourLocal < o.nightEndHour;

  // --- 1. Is the address downwind? -----------------------------------------
  // Plume travels toward (windDir + 180). The effective corridor is much wider
  // than a textbook Gaussian plume for two reasons: Port Townsend's winds shift
  // hour to hour around the corner where the strait, the bay and Discovery Bay
  // meet, and a model's 10 m wind direction is itself only good to ±20-30° at
  // this lead time. Light winds meander more; close in, the source subtends a
  // wider angle. Narrower than this and the forecast flips on rounding error.
  const travelDir = (num(h.windDir, 0) + 180) % 360;
  const offAxisDeg = angDiff(travelDir, geo.bearingFromMill);
  const sigmaDeg = 30 + 30 * Math.exp(-ws / 1.5) + 15 * Math.exp(-geo.distKm / 1.5);
  const alignment = Math.exp(-0.5 * (offAxisDeg / sigmaDeg) ** 2);

  // Decoupling. When the wind is light AND the boundary layer has collapsed to
  // a few tens of metres, the 10 m wind direction stops describing anything
  // real: the surface layer detaches from the flow above, drainage off the
  // Quimper hills takes over, and the plume snakes through a wide sector over
  // the course of a few hours. Wind speed alone is not enough of a test — a
  // 1.5 m/s wind under a 400 m mixed layer is still a direction, while the same
  // speed under a 45 m layer is not. Hindcasting the 31 Aug 2026 event showed
  // the wind-only version scoring those hours at 2%.
  const blh = Number.isFinite(h.blh) ? h.blh : null;
  const shallow = blh === null ? 0.3 : clamp((150 - blh) / 130);
  const lightWind = clamp((2.5 - ws) / 2.0);
  const decoupled = lightWind * (0.4 + 0.6 * shallow);
  const directional = Math.max(alignment, 0.5 * decoupled);

  // --- 2. Distance decay ----------------------------------------------------
  const distance = 1 / (1 + (geo.distKm / 4.0) ** 1.6);

  // --- 3. Wind speed: transport vs. dilution --------------------------------
  // A light steady breeze delivers undiluted odor; a gale shreds it.
  const windSpeed = Math.max(0.12, Math.exp(-0.5 * ((ws - 2.6) / 2.3) ** 2));

  // --- 4. Atmospheric stability / trapping ----------------------------------
  // The dominant nighttime mechanism: a surface inversion caps the plume in a
  // shallow layer instead of letting it loft away.
  const t2 = num(h.temp2m, 12);
  const invLow = Number.isFinite(h.temp1000) ? h.temp1000 - t2 + 1.1 : null; // ~110 m
  const invMid = Number.isFinite(h.temp925) ? (h.temp925 - t2 + 5.0) * 0.5 : null; // ~760 m
  const invParts = [invLow !== null ? clamp(invLow / 3) : null,
                    invMid !== null ? clamp(invMid / 3) : null].filter((v) => v !== null);
  const sInv = invParts.length ? invParts.reduce((a, b) => a + b) / invParts.length : 0.3;

  const sBlh = blh === null ? 0.3 : clamp((600 - blh) / 500);
  const sWind = clamp((5 - ws) / 4.5);
  const sClear = isNight ? clamp((70 - num(h.cloudCover, 50)) / 60) : 0;
  const stability = clamp(0.4 * sInv + 0.3 * sBlh + 0.2 * sWind + 0.1 * sClear);

  // --- 5. Fog and humidity --------------------------------------------------
  // Reduced sulfur compounds partition into fog droplets and hang at nose level;
  // fog also implies a saturated, very shallow, very stable layer.
  const vis = num(h.visibility, 20000);
  const fog = vis < 2000 ? 1 : clamp((6000 - vis) / 4000);
  const humid = clamp((num(h.rh, 70) - 85) / 13);
  const moisture = Math.max(fog, 0.8 * humid);

  // --- 6. Rain washout ------------------------------------------------------
  const rain = Math.exp(-num(h.precip, 0) / 1.5);

  // --- 7. Cold-air pooling in low-lying, shoreline addresses ----------------
  const lowLying = clamp((40 - geo.elevationM) / 40);
  const pooling = 1 + 0.5 * lowLying * stability;

  const nightMul = isNight ? 1.0 : 0.85;

  const exposure =
    directional *
    distance *
    windSpeed *
    rain *
    (0.35 + 0.65 * stability) *
    (1 + 0.45 * moisture) *
    pooling *
    nightMul;

  const z = (Math.log(Math.max(exposure, 1e-9)) - Math.log(o.e50)) / o.k;
  const p = clamp(1 / (1 + Math.exp(-z)), o.pMin, o.pMax);

  return {
    p,
    exposure,
    factors: {
      alignment: directional,
      offAxisDeg,
      distance,
      windSpeed,
      stability,
      moisture,
      rain,
      pooling: pooling - 1,
      isNight,
      ws,
      windDir: num(h.windDir, 0),
      decoupled,
    },
  };
}

// ---------------------------------------------------------------------------
// Night aggregation
// ---------------------------------------------------------------------------

/**
 * Combine the hours of one night into a single probability.
 *
 * Consecutive hours are heavily correlated — twelve bad hours are not twelve
 * independent chances — so this is a noisy-OR with a geometric decay applied to
 * successively less-severe hours.
 */
export function scoreNight(hours, geo, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const scored = hours
    .map((h) => ({ hour: h, ...scoreHour(h, geo, o) }))
    .sort((a, b) => a.hour.time - b.hour.time);

  if (!scored.length) return null;

  const ranked = [...scored].sort((a, b) => b.p - a.p);
  let survive = 1;
  ranked.forEach((s, i) => {
    survive *= 1 - s.p * o.hourDecay ** i;
  });
  const p = clamp(1 - survive, o.pMin, o.pMax);

  return { p, level: level(p), peak: ranked[0], hours: scored };
}

export function level(p) {
  if (p < 0.1) return { key: 'unlikely', label: 'Unlikely' };
  if (p < 0.25) return { key: 'low', label: 'Low chance' };
  if (p < 0.5) return { key: 'possible', label: 'Possible' };
  if (p < 0.75) return { key: 'likely', label: 'Likely' };
  return { key: 'very-likely', label: 'Very likely' };
}

/**
 * Split normalized hourly data into consecutive nights and score each.
 * A "night" runs from nightStartHour on day D to nightEndHour on day D+1.
 */
export function buildNights(hourly, geo, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const buckets = new Map();

  for (const h of hourly) {
    const inWindow = h.hourLocal >= o.nightStartHour || h.hourLocal < o.nightEndHour;
    if (!inWindow) continue;
    // Hours after midnight belong to the previous calendar day's night.
    const anchor = new Date(h.time.getTime());
    if (h.hourLocal < o.nightEndHour) anchor.setDate(anchor.getDate() - 1);
    const key = nightKey(anchor);
    if (!buckets.has(key)) buckets.set(key, { key, date: new Date(anchor), hours: [] });
    buckets.get(key).hours.push(h);
  }

  return [...buckets.values()]
    .sort((a, b) => a.date - b.date)
    .map((b) => ({ ...b, ...scoreNight(b.hours, geo, o) }))
    .filter((n) => n.p !== undefined);
}

/** Stable YYYY-MM-DD identifier for the evening a night begins on. */
export function nightKey(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Which night is "tonight" right now? */
export function currentNightKey(now, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const anchor = new Date(now.getTime());
  if (now.getHours() < o.nightEndHour) anchor.setDate(anchor.getDate() - 1);
  return nightKey(anchor);
}

// ---------------------------------------------------------------------------
// Plain-language explanation
// ---------------------------------------------------------------------------

/** Rank the drivers of a night's peak hour and describe them in English. */
export function explain(night, geo) {
  if (!night?.peak) return [];
  const f = night.peak.factors;
  const out = [];

  if (f.decoupled > 0.45 && f.alignment < 0.5) {
    out.push({
      good: false,
      text: `Light wind (${fmtSpeed(f.ws)}) under a collapsed boundary layer — the plume drifts and pools locally rather than blowing in any one direction.`,
    });
  } else if (f.alignment > 0.6) {
    out.push({
      good: false,
      text: `You are close to directly downwind: ${compass(f.windDir)} wind puts you ${Math.round(f.offAxisDeg)}° off the plume centerline.`,
    });
  } else if (f.alignment > 0.3) {
    out.push({
      good: false,
      text: `Partly downwind — ${compass(f.windDir)} wind, ${Math.round(f.offAxisDeg)}° off the plume centerline.`,
    });
  } else if (f.alignment > 0.12) {
    out.push({
      good: false,
      text: `On the edge of the plume — ${compass(f.windDir)} wind, ${Math.round(f.offAxisDeg)}° off centerline, so it depends on how much the wind wanders.`,
    });
  } else {
    out.push({
      good: true,
      text: `Wind from the ${compass(f.windDir)} carries the plume away from you (${Math.round(f.offAxisDeg)}° off centerline).`,
    });
  }

  if (f.stability > 0.65) {
    out.push({ good: false, text: 'Strong inversion and a shallow, stagnant boundary layer trap odor near the ground.' });
  } else if (f.stability > 0.4) {
    out.push({ good: false, text: 'Moderately stable air — some trapping near the surface.' });
  } else {
    out.push({ good: true, text: 'Well-mixed air disperses the plume upward.' });
  }

  if (f.moisture > 0.5) out.push({ good: false, text: 'Fog or near-saturated air holds odor compounds at nose level.' });
  if (f.rain < 0.6) out.push({ good: true, text: 'Rain is washing sulfur compounds out of the air.' });
  if (f.windSpeed < 0.3) out.push({ good: true, text: `Strong wind (${fmtSpeed(f.ws)}) dilutes the plume quickly.` });
  if (f.pooling > 0.15) out.push({ good: false, text: 'Your address is low-lying, where cold air and heavy odor gases settle.' });

  out.push({
    good: geo.distKm > 6,
    text: `You are ${fmtDistance(geo.distKm)} ${compass(geo.bearingFromMill)} of the mill.`,
  });

  return out;
}

function num(v, fallback) {
  return Number.isFinite(v) ? v : fallback;
}
