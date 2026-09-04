/**
 * Display formatting. The model works entirely in SI — metres, m/s, kilometres,
 * Celsius — because that is what the weather APIs return and what the physics
 * is written in. Nothing here is ever fed back into the model; this module
 * exists purely so the app can speak to people in Port Townsend in the units
 * they actually use.
 */

const KM_PER_MI = 1.609344;
const MPS_PER_MPH = 0.44704;
const M_PER_FT = 0.3048;

export const kmToMi = (km) => km / KM_PER_MI;
export const mpsToMph = (mps) => mps / MPS_PER_MPH;
export const mToFt = (m) => m / M_PER_FT;
export const cToF = (c) => c * 9 / 5 + 32;

/** "2.2 mi" — one decimal under 10 miles, none above. */
export function fmtDistance(km) {
  const mi = kmToMi(km);
  return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
}

/** "7 mph". Rounded: sub-mph precision is meaningless in a forecast. */
export function fmtSpeed(mps) {
  return `${Math.round(mpsToMph(mps))} mph`;
}

/** "250 ft", rounded to the nearest 10 to avoid implying DEM precision. */
export function fmtElevation(m) {
  if (!Number.isFinite(m)) return '—';
  return `${Math.round(mToFt(m) / 10) * 10} ft`;
}

/** Visibility, where the interesting range is the low end. */
export function fmtVisibility(m) {
  if (!Number.isFinite(m)) return '—';
  const mi = kmToMi(m / 1000);
  if (mi < 0.5) return '<½ mi';
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

export function fmtTemp(c) {
  return Number.isFinite(c) ? `${Math.round(cToF(c))}°F` : '—';
}

/** 0 -> "12am", 13 -> "1pm". */
export function fmtHour12(h) {
  const hour = ((h % 24) + 24) % 24;
  const suffix = hour < 12 ? 'am' : 'pm';
  return `${((hour + 11) % 12) + 1}${suffix}`;
}

/** "7pm – 7am" */
export function fmtHourRange(startHour, endHour) {
  return `${fmtHour12(startHour)} – ${fmtHour12(endHour)}`;
}
