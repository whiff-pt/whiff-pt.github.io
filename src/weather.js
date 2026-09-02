/**
 * Data access: Open-Meteo forecasts + elevation, Nominatim geocoding.
 * Works unmodified in the browser and in Node 18+ (both have global fetch).
 * No API keys anywhere.
 */

import { MILL } from './model.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const HISTORY_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';
const GEOCODE_URL = 'https://nominatim.openstreetmap.org/search';

export const TIMEZONE = 'America/Los_Angeles';

const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'cloud_cover',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'boundary_layer_height',
  'temperature_1000hPa',
  'temperature_925hPa',
];

/**
 * Fetch and normalize hourly weather at the mill.
 *
 * The plume's fate is governed by conditions at and just downwind of the
 * source, and Port Townsend is far smaller than any forecast grid cell, so a
 * single query at the mill is both simpler and more defensible than one per
 * address.
 *
 * @param {{days?:number, model?:string}} [opts]
 * @returns {Promise<{hourly:Array, model:string, grid:{lat:number,lon:number,elevation:number}}>}
 */
export async function fetchWeather(opts = {}) {
  const days = opts.days ?? 5;
  const model = opts.model ?? 'best_match';
  const url =
    `${FORECAST_URL}?latitude=${MILL.lat}&longitude=${MILL.lon}` +
    `&hourly=${HOURLY_VARS.join(',')}` +
    `&timezone=${encodeURIComponent(TIMEZONE)}&forecast_days=${days}` +
    `&wind_speed_unit=ms&past_hours=3` +
    (model === 'best_match' ? '' : `&models=${encodeURIComponent(model)}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || 'Open-Meteo error');

  return {
    model,
    grid: { lat: data.latitude, lon: data.longitude, elevation: data.elevation },
    hourly: normalizeHourly(data.hourly),
  };
}

/**
 * Same variables, but for dates that have already happened — the archived
 * high-resolution model runs rather than reanalysis, so it is the closest thing
 * to "what the app would have said at the time".
 *
 * @param {string} startDate ISO date, e.g. '2026-08-31'
 * @param {string} endDate   ISO date, inclusive
 */
export async function fetchHistory(startDate, endDate, opts = {}) {
  const model = opts.model ?? 'best_match';
  const url =
    `${HISTORY_URL}?latitude=${MILL.lat}&longitude=${MILL.lon}` +
    `&hourly=${HOURLY_VARS.join(',')}` +
    `&timezone=${encodeURIComponent(TIMEZONE)}` +
    `&start_date=${startDate}&end_date=${endDate}&wind_speed_unit=ms` +
    (model === 'best_match' ? '' : `&models=${encodeURIComponent(model)}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo archive returned ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.reason || 'Open-Meteo archive error');

  return {
    model,
    grid: { lat: data.latitude, lon: data.longitude, elevation: data.elevation },
    hourly: normalizeHourly(data.hourly),
  };
}

/**
 * Open-Meteo returns parallel arrays of local wall-clock timestamps.
 * Flip them into per-hour records the model can consume.
 */
export function normalizeHourly(h) {
  if (!h?.time) return [];
  const pick = (name, i) => {
    const arr = h[name];
    const v = arr ? arr[i] : null;
    return v === null || v === undefined ? NaN : v;
  };
  return h.time.map((t, i) => {
    // Timestamps are already in TIMEZONE; parsing without an offset gives a
    // Date whose *local* fields match, which is what the model reads.
    const time = new Date(t);
    return {
      time,
      iso: t,
      hourLocal: time.getHours(),
      temp2m: pick('temperature_2m', i),
      rh: pick('relative_humidity_2m', i),
      dewPoint: pick('dew_point_2m', i),
      precip: pick('precipitation', i),
      cloudCover: pick('cloud_cover', i),
      visibility: pick('visibility', i),
      windSpeed: pick('wind_speed_10m', i),
      windDir: pick('wind_direction_10m', i),
      gust: pick('wind_gusts_10m', i),
      blh: pick('boundary_layer_height', i),
      temp1000: pick('temperature_1000hPa', i),
      temp925: pick('temperature_925hPa', i),
    };
  });
}

/**
 * "Now", expressed as a Date whose *local* fields are Port Townsend wall-clock
 * time. Open-Meteo timestamps parse the same way, so the two are comparable
 * even when the device is in another timezone.
 */
export function nowInPT() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return new Date(`${g('year')}-${g('month')}-${g('day')}T${g('hour').replace('24', '00')}:${g('minute')}:${g('second')}`);
}

/** Ground elevation in metres for a point, or null if unavailable. */
export async function fetchElevation(lat, lon) {
  try {
    const res = await fetch(`${ELEVATION_URL}?latitude=${lat}&longitude=${lon}`);
    if (!res.ok) return null;
    const data = await res.json();
    const v = data?.elevation?.[0];
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Geocode a street address. Biased to the Quimper Peninsula but not restricted
 * to it, so "Marrowstone" or "Cape George" still resolve.
 */
export async function geocode(query) {
  const params = new URLSearchParams({
    q: /wa\b|washington/i.test(query) ? query : `${query}, Port Townsend, WA`,
    format: 'jsonv2',
    limit: '5',
    countrycodes: 'us',
    viewbox: '-123.10,48.25,-122.55,47.90', // lon_min,lat_max,lon_max,lat_min
    bounded: '0',
  });
  const res = await fetch(`${GEOCODE_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      // Nominatim's usage policy requires an identifying User-Agent and 403s
      // Node's default. Browsers treat this as a forbidden header and drop it,
      // sending their own, which is equally acceptable to Nominatim.
      'User-Agent': 'whiff/0.1 (Port Townsend mill odor forecast)',
    },
  });
  if (!res.ok) throw new Error(`Geocoder returned ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    label: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
  }));
}
