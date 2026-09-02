/**
 * Opt-in shared logging.
 *
 * Thirty private logs are thirty anecdotes; one shared table is a dataset. This
 * module is the bridge — and the whole privacy surface of the app, so the rules
 * are concentrated here rather than scattered through the UI:
 *
 *   1. Off unless the person explicitly turns it on. No pre-ticked boxes.
 *   2. The street address NEVER leaves the browser. What goes is distance and
 *      bearing from the mill, deliberately coarsened to a neighbourhood-sized
 *      cell — which is all the model actually consumes anyway.
 *   3. Identity is a random UUID generated on this device. No name, no email,
 *      no account.
 *   4. Nothing is sent retroactively. Turning sharing on shares tonight and
 *      onward, not the log already sitting in localStorage.
 *
 * Point 4 matters: someone who has been logging privately for a month did not
 * consent to publishing that month.
 */

import { SHARE, isShareConfigured } from './share-config.js';

const INSTALL_KEY = 'whiff.install.v1';

/** A stable anonymous id for this browser. Not linked to anything. */
export function installId() {
  let id = null;
  try {
    id = localStorage.getItem(INSTALL_KEY);
  } catch { /* storage blocked; fall through to an ephemeral id */ }
  if (id) return id;

  id = (globalThis.crypto?.randomUUID?.() ?? fallbackUuid());
  try { localStorage.setItem(INSTALL_KEY, id); } catch { /* ephemeral */ }
  return id;
}

function fallbackUuid() {
  // Only reached on browsers without crypto.randomUUID or outside a secure
  // context. Quality matters little: this is a bucket label, not a secret.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Blur the location to a neighbourhood. At 3 km from the mill, 0.25 km by 10°
 * is roughly a 250 m x 520 m cell — enough to model with, too coarse to point
 * at a house. In a town this small that distinction is the whole ballgame.
 */
export function coarsenLocation(geo) {
  return {
    dist_km: Math.round(geo.distKm * 4) / 4,
    bearing_deg: (Math.round(geo.bearingFromMill / 10) * 10) % 360,
    elevation_m: Number.isFinite(geo.elevationM) ? Math.round(geo.elevationM / 10) * 10 : null,
  };
}

/** Exactly what a submission contains — used by the UI to show people. */
export function buildRow(entry, geo) {
  return {
    install_id: installId(),
    night: entry.night,
    smell: entry.smell,
    smell_window: entry.smellWindow ?? null,
    ...coarsenLocation(geo),
    predicted: entry.predicted,
    peak_hour: entry.peakHour ? Number(entry.peakHour.slice(11, 13)) : null,
    wind_dir: entry.windDir,
    wind_speed: entry.windSpeed,
    alignment: entry.alignment,
    stability: entry.stability,
    moisture: entry.moisture,
    decoupled: entry.decoupled ?? null,
    model_version: entry.modelVersion,
  };
}

/**
 * Upsert one night's report. Resolves to true on success.
 *
 * Deliberately does not throw: a failed share must never cost someone their
 * local log entry, which is the record that actually matters to them.
 */
export async function submit(entry, geo) {
  if (!isShareConfigured()) return false;
  const row = buildRow(entry, geo);

  try {
    const res = await fetch(
      `${SHARE.url.replace(/\/$/, '')}/rest/v1/observations?on_conflict=install_id,night`,
      {
        method: 'POST',
        headers: {
          apikey: SHARE.anonKey,
          Authorization: `Bearer ${SHARE.anonKey}`,
          'Content-Type': 'application/json',
          // Re-reporting the same night overwrites, so people can correct
          // themselves at 3am after logging "nothing" at 9pm.
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      },
    );
    if (!res.ok) {
      console.warn('Whiff: share failed', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Whiff: share unreachable', err.message);
    return false;
  }
}

/**
 * Ask for removal of everything this install has contributed. Insert-only
 * policies mean the client cannot delete rows itself — which is the right
 * trade for tamper-resistance, but it means removal is a request, not an
 * action, and the UI must say so honestly.
 */
export async function requestRemoval() {
  if (!isShareConfigured()) return false;
  try {
    const res = await fetch(`${SHARE.url.replace(/\/$/, '')}/rest/v1/removal_requests`, {
      method: 'POST',
      headers: {
        apikey: SHARE.anonKey,
        Authorization: `Bearer ${SHARE.anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ install_id: installId() }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export { isShareConfigured, SHARE };
