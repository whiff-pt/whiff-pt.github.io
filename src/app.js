/* Whiff — UI layer. State lives in localStorage; all forecasting is in model.js. */

import {
  MILL, DEFAULTS, MODEL_VERSION, siteGeometry, buildNights, currentNightKey, explain,
  compass, clamp, level,
} from './model.js';
import { fetchWeather, fetchElevation, geocode, nowInPT } from './weather.js';
import { submit, requestRemoval, buildRow, isShareConfigured } from './share.js';

const $ = (id) => document.getElementById(id);
const STORE = 'whiff.settings.v1';
const LOG = 'whiff.log.v1';

const state = {
  site: null, // {lat, lon, label, elevationM}
  threshold: 50,
  notifyEnabled: false,
  nightStartHour: DEFAULTS.nightStartHour,
  nightEndHour: DEFAULTS.nightEndHour,
  model: 'best_match',
  lastNotifiedNight: null,
  shareEnabled: false, // never default this to true
  hasEverShared: false,
  nights: [],
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function load() {
  try {
    Object.assign(state, JSON.parse(localStorage.getItem(STORE) || '{}'));
  } catch { /* first run, private mode, or cleared storage */ }
}
function save() {
  try {
    const { nights, ...persist } = state;
    localStorage.setItem(STORE, JSON.stringify(persist));
  } catch { /* storage unavailable; settings just won't survive a reload */ }
}
function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG) || '[]'); } catch { return []; }
}
function writeLog(rows) {
  try { localStorage.setItem(LOG, JSON.stringify(rows)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

let map, siteMarker, plumeLayer;

function initMap() {
  map = L.map('map', { scrollWheelZoom: false }).setView([48.105, -122.79], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  L.circleMarker([MILL.lat, MILL.lon], {
    radius: 8, color: '#c23a2b', fillColor: '#c23a2b', fillOpacity: .85, weight: 2,
  }).addTo(map).bindTooltip('Port Townsend Paper Co.', { permanent: false });

  map.on('click', (e) => setSite({ lat: e.latlng.lat, lon: e.latlng.lng, label: 'Dropped pin' }));
}

function drawSite() {
  if (!state.site) return;
  const { lat, lon } = state.site;
  if (siteMarker) map.removeLayer(siteMarker);
  siteMarker = L.marker([lat, lon], { draggable: true }).addTo(map)
    .bindTooltip('You', { permanent: false });
  siteMarker.on('dragend', () => {
    const p = siteMarker.getLatLng();
    setSite({ lat: p.lat, lon: p.lng, label: 'Dropped pin' });
  });
  map.fitBounds(L.latLngBounds([[MILL.lat, MILL.lon], [lat, lon]]).pad(0.45));
}

/** Shade the plume corridor for the peak hour of tonight. */
function drawPlume(night) {
  if (plumeLayer) { map.removeLayer(plumeLayer); plumeLayer = null; }
  if (!night?.peak) return;
  const f = night.peak.factors;
  if (f.decoupled > 0.6) return; // flow is decoupled; no honest direction to draw

  const travel = (f.windDir + 180) % 360;
  const sigma = 30 + 30 * Math.exp(-f.ws / 1.5); // keep in step with model.js
  const reach = 14; // km
  const pts = [[MILL.lat, MILL.lon]];
  for (let a = -sigma; a <= sigma; a += sigma / 8) pts.push(offset(MILL, travel + a, reach));
  pts.push([MILL.lat, MILL.lon]);

  plumeLayer = L.polygon(pts, {
    color: '#c23a2b', weight: 1, opacity: .5, fillColor: '#c23a2b', fillOpacity: .13,
  }).addTo(map).bindTooltip(`Plume corridor at the worst hour (${compass(f.windDir)} wind)`);
}

function offset(from, bearing, km) {
  const R = 6371.0088;
  const br = (bearing * Math.PI) / 180;
  const φ1 = (from.lat * Math.PI) / 180;
  const λ1 = (from.lon * Math.PI) / 180;
  const δ = km / R;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(br));
  const λ2 = λ1 + Math.atan2(Math.sin(br) * Math.sin(δ) * Math.cos(φ1),
                             Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [(φ2 * 180) / Math.PI, (λ2 * 180) / Math.PI];
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

async function setSite(site) {
  state.site = { ...state.site, ...site };
  $('locationSummary').textContent = 'Locating…';
  drawSite();
  const elev = await fetchElevation(site.lat, site.lon);
  if (elev !== null) state.site.elevationM = elev;
  save();
  const geo = siteGeometry(state.site);
  $('locationSummary').innerHTML =
    `<strong>${escapeHtml(state.site.label || 'Your spot')}</strong> — ` +
    `${geo.distKm.toFixed(1)} km ${compass(geo.bearingFromMill)} of the mill` +
    (state.site.elevationM != null ? `, ${Math.round(state.site.elevationM)} m elevation` : '');
  await refresh();
}

let refreshing = false;
async function refresh() {
  if (!state.site || refreshing) return;
  refreshing = true;
  $('dataStamp').textContent = ' Loading forecast…';
  try {
    const opts = { nightStartHour: state.nightStartHour, nightEndHour: state.nightEndHour };
    const days = state.model === 'gfs_hrrr' ? 2 : 5;
    const wx = await fetchWeather({ days, model: state.model });
    const geo = siteGeometry(state.site);
    const now = nowInPT();
    const todayKey = currentNightKey(now, opts);

    const all = buildNights(wx.hourly, geo, opts);
    const startIdx = all.findIndex((n) => n.key === todayKey);
    state.nights = startIdx >= 0 ? all.slice(startIdx) : all;

    render(geo, now);
    flushUnshared();
    $('dataStamp').textContent =
      ` Open-Meteo ${wx.model}, updated ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    maybeNotify();
  } catch (err) {
    $('dataStamp').innerHTML = ` <span class="error">Forecast unavailable: ${escapeHtml(err.message)}</span>`;
  } finally {
    refreshing = false;
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(geo, now) {
  const tonight = state.nights[0];
  for (const id of ['verdictCard', 'outlookCard', 'feedbackCard']) $(id).hidden = !tonight;
  if (!tonight) return;

  const pct = Math.round(tonight.p * 100);
  const lvl = tonight.level;

  $('pctText').textContent = `${pct}%`;
  $('levelText').textContent = lvl.label;
  $('levelText').className = `level lvl-${lvl.key}`;

  const circ = 2 * Math.PI * 84;
  const dial = $('dialValue');
  dial.style.strokeDashoffset = String(circ * (1 - tonight.p));
  dial.style.stroke = `var(--${lvl.key})`;

  const peakTime = tonight.peak.hour.time;
  $('nightLabel').textContent =
    `${nightName(tonight.date, now)} · ${state.nightStartHour}:00–${String(state.nightEndHour).padStart(2, '0')}:00`;
  $('headline').innerHTML = pct >= 50
    ? `<strong>${lvl.label}.</strong> Worst around ${fmtHour(peakTime)} (${Math.round(tonight.peak.p * 100)}% that hour).`
    : `<strong>${lvl.label}.</strong> Peak risk near ${fmtHour(peakTime)}.`;

  $('reasons').innerHTML = explain(tonight, geo)
    .map((r) => `<li class="${r.good ? 'good' : 'bad'}">${escapeHtml(r.text)}</li>`)
    .join('');

  renderFactors(tonight.peak.factors);
  renderHours(tonight);
  renderOutlook(now);
  renderFeedback(tonight);
  drawPlume(tonight);
}

function renderFactors(f) {
  const rows = [
    ['Downwind alignment', f.alignment, `${Math.round(f.offAxisDeg)}°`],
    ['Distance from mill', f.distance, ''],
    ['Wind speed window', f.windSpeed, `${f.ws.toFixed(1)}`],
    ['Inversion / stagnation', f.stability, ''],
    ['Fog & humidity', f.moisture, ''],
    ['Cold-air pooling', clamp(f.pooling / 0.5), ''],
    ['Rain washout (higher = drier)', f.rain, ''],
  ];
  $('factorBars').innerHTML = rows.map(([name, v, note]) => `
    <li>
      <span>${name}</span>
      <span class="bar"><span style="width:${(clamp(v) * 100).toFixed(0)}%"></span></span>
      <span class="val">${note || Math.round(clamp(v) * 100)}</span>
    </li>`).join('');
}

function renderHours(night) {
  const peakTime = night.peak.hour.time.getTime();
  $('hourTable').tBodies[0].innerHTML = night.hours.map((s) => {
    const h = s.hour;
    return `<tr class="${h.time.getTime() === peakTime ? 'peak' : ''}">
      <td>${fmtHour(h.time)}</td>
      <td class="lvl-${level(s.p).key}">${Math.round(s.p * 100)}%</td>
      <td>${compass(h.windDir)} ${h.windSpeed.toFixed(1)}</td>
      <td>${Math.round(s.factors.offAxisDeg)}°</td>
      <td>${Math.round(s.factors.stability * 100)}</td>
      <td>${Number.isFinite(h.rh) ? Math.round(h.rh) : '–'}%</td>
      <td>${Number.isFinite(h.visibility) ? (h.visibility / 1000).toFixed(1) + ' km' : '–'}</td>
    </tr>`;
  }).join('');
}

function renderOutlook(now) {
  $('outlook').innerHTML = state.nights.slice(0, 5).map((n) => `
    <li>
      <span>${nightName(n.date, now)}</span>
      <span class="bar"><span style="width:${(n.p * 100).toFixed(0)}%;background:var(--${n.level.key})"></span></span>
      <span class="val">${Math.round(n.p * 100)}%</span>
    </li>`).join('');
}

function renderFeedback(tonight) {
  const rows = readLog();
  const mine = rows.find((r) => r.night === tonight.key);

  document.querySelectorAll('.report').forEach((b) => {
    b.setAttribute('aria-pressed', String(mine?.smell === Number(b.dataset.smell)));
  });

  // The timing question only makes sense once something was actually smelled.
  $('whenBlock').hidden = !(mine && mine.smell >= 1);
  document.querySelectorAll('.when').forEach((b) => {
    b.setAttribute('aria-pressed', String(mine?.smellWindow === b.dataset.when));
  });

  const needsWhen = mine && mine.smell >= 1 && !mine.smellWindow;
  $('feedbackStatus').textContent = needsWhen
    ? 'Logged — now pick roughly when, above.'
    : mine
      ? `Logged for tonight. ${rows.length} report${rows.length === 1 ? '' : 's'} saved on this device.`
      : `${rows.length} report${rows.length === 1 ? '' : 's'} saved on this device.`;

  renderShareState(mine);
}

// ---------------------------------------------------------------------------
// Shared logging
// ---------------------------------------------------------------------------

function renderShareState(mine) {
  if (!isShareConfigured()) return; // block stays hidden; app is local-only
  $('shareEnabled').checked = state.shareEnabled;
  $('removalBtn').hidden = !state.hasEverShared;

  if (!state.shareEnabled) {
    $('shareStatus').textContent = '';
  } else if (mine?.shared) {
    $('shareStatus').textContent = "Tonight's report has been contributed. Thank you.";
  } else if (mine) {
    $('shareStatus').textContent = 'Will be contributed once you pick a time band.';
  } else {
    $('shareStatus').textContent = 'Sharing is on. Nothing sent yet tonight.';
  }
  if (!$('sharePreview').hidden) refreshPreview(mine);
}

/** Show the literal JSON body, so "what gets sent" is not a promise but a fact. */
function refreshPreview(mine) {
  const geo = state.site ? siteGeometry(state.site) : null;
  if (!geo) return;
  const sample = mine ?? {
    night: state.nights[0]?.key ?? '—',
    smell: 0,
    smellWindow: null,
    predicted: Number((state.nights[0]?.p ?? 0).toFixed(4)),
    peakHour: state.nights[0]?.peak.hour.iso,
    windDir: state.nights[0]?.peak.factors.windDir,
    windSpeed: state.nights[0]?.peak.factors.ws,
    alignment: 0, stability: 0, moisture: 0, decoupled: 0,
    modelVersion: MODEL_VERSION,
  };
  $('sharePreview').textContent = JSON.stringify(buildRow(sample, geo), null, 2);
}

/**
 * Send a report if sharing is on and it is complete. A report with a smell but
 * no time band is deliberately withheld — the timing is the most valuable
 * column in the table, and a half-filled row would dilute it.
 */
async function maybeShare(entry) {
  if (!isShareConfigured() || !state.shareEnabled || !state.site) return;
  if (entry.smell >= 1 && !entry.smellWindow) return;

  const ok = await submit(entry, siteGeometry(state.site));
  if (ok) {
    const rows = readLog();
    const row = rows.find((r) => r.night === entry.night);
    if (row) { row.shared = true; writeLog(rows); }
    state.hasEverShared = true;
    save();
  }
  const tonight = state.nights[0];
  if (tonight) renderFeedback(tonight);
}

/** Retry anything that failed to send while offline. */
async function flushUnshared() {
  if (!isShareConfigured() || !state.shareEnabled || !state.site) return;
  const pending = readLog().filter((r) => !r.shared && !(r.smell >= 1 && !r.smellWindow));
  for (const entry of pending) await maybeShare(entry);
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

async function maybeNotify() {
  const tonight = state.nights[0];
  if (!tonight || !state.notifyEnabled) return;
  if (tonight.p * 100 < state.threshold) return;
  if (state.lastNotifiedNight === tonight.key) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  new Notification(`👃 ${Math.round(tonight.p * 100)}% chance of mill odor tonight`, {
    body: `${tonight.level.label} at ${state.site.label || 'your address'}. Worst around ${fmtHour(tonight.peak.hour.time)}.`,
    tag: `whiff-${tonight.key}`,
  });
  state.lastNotifiedNight = tonight.key;
  save();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function fmtHour(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', hour12: true }).replace(' ', '').toLowerCase();
}

function nightName(date, now) {
  const day = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day(date) === day(now)) return 'Tonight';
  if (day(date) === day(tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString([], { weekday: 'short' });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function wire() {
  $('addressForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('addressInput').value.trim();
    if (!q) return;
    const list = $('geoResults');
    list.hidden = false;
    list.innerHTML = '<li><button type="button" disabled>Searching…</button></li>';
    try {
      const hits = await geocode(q);
      if (!hits.length) {
        list.innerHTML = '<li><button type="button" disabled>No match — try dropping a pin on the map.</button></li>';
        return;
      }
      list.innerHTML = '';
      hits.forEach((h) => {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = h.label;
        btn.onclick = () => { list.hidden = true; setSite({ lat: h.lat, lon: h.lon, label: h.label.split(',').slice(0, 2).join(',') }); };
        li.append(btn);
        list.append(li);
      });
    } catch (err) {
      list.innerHTML = `<li><button type="button" disabled>Geocoder failed: ${escapeHtml(err.message)}</button></li>`;
    }
  });

  $('gpsBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => setSite({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'My location' }),
      () => { $('locationSummary').innerHTML = '<span class="error">Location permission denied.</span>'; },
    );
  });

  $('detailsToggle').addEventListener('click', () => {
    const d = $('details');
    d.hidden = !d.hidden;
    $('detailsToggle').textContent = d.hidden ? 'Show the numbers' : 'Hide the numbers';
  });

  $('threshold').addEventListener('input', (e) => {
    state.threshold = Number(e.target.value);
    $('thresholdOut').textContent = `${state.threshold}%`;
    save();
  });

  $('notifyEnabled').addEventListener('change', async (e) => {
    if (e.target.checked && 'Notification' in window) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { e.target.checked = false; return; }
    }
    state.notifyEnabled = e.target.checked;
    save();
    maybeNotify();
  });

  for (const [id, key] of [['nightStart', 'nightStartHour'], ['nightEnd', 'nightEndHour']]) {
    $(id).addEventListener('change', (e) => {
      state[key] = Number(e.target.value);
      save();
      refresh();
    });
  }

  $('modelSelect').addEventListener('change', (e) => {
    state.model = e.target.value;
    save();
    refresh();
  });

  document.querySelectorAll('.report').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tonight = state.nights[0];
      if (!tonight) return;
      const geo = siteGeometry(state.site);
      const f = tonight.peak.factors;
      const prev = readLog().find((r) => r.night === tonight.key);
      const smell = Number(btn.dataset.smell);
      const rows = readLog().filter((r) => r.night !== tonight.key);
      const entry = {
        night: tonight.key,
        loggedAt: new Date().toISOString(),
        smell,
        // "Nothing" has no time band; changing the severity keeps the band.
        smellWindow: smell === 0 ? null : (prev?.smellWindow ?? null),
        predicted: Number(tonight.p.toFixed(4)),
        peakHour: tonight.peak.hour.iso,
        windDir: f.windDir,
        windSpeed: Number(f.ws.toFixed(2)),
        alignment: Number(f.alignment.toFixed(3)),
        stability: Number(f.stability.toFixed(3)),
        moisture: Number(f.moisture.toFixed(3)),
        decoupled: Number(f.decoupled.toFixed(3)),
        distKm: Number(geo.distKm.toFixed(2)),
        bearing: Math.round(geo.bearingFromMill),
        modelVersion: MODEL_VERSION,
        shared: false,
      };
      rows.push(entry);
      writeLog(rows);
      renderFeedback(tonight);
      maybeShare(entry);
    });
  });

  document.querySelectorAll('.when').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tonight = state.nights[0];
      if (!tonight) return;
      const rows = readLog();
      const entry = rows.find((r) => r.night === tonight.key);
      if (!entry) return;
      entry.smellWindow = btn.dataset.when;
      entry.shared = false; // the row changed, so re-send it
      writeLog(rows);
      renderFeedback(tonight);
      maybeShare(entry);
    });
  });

  if (isShareConfigured()) {
    $('shareBlock').hidden = false;
    $('shareEnabled').addEventListener('change', (e) => {
      state.shareEnabled = e.target.checked;
      save();
      // Only ever forward-looking: turning this on does not publish the log
      // that already exists, only nights logged from here on.
      if (state.shareEnabled) {
        const tonight = state.nights[0];
        const mine = tonight && readLog().find((r) => r.night === tonight.key);
        if (mine) maybeShare(mine);
      }
      renderFeedback(state.nights[0] ?? { key: null });
    });

    $('shareDetailsToggle').addEventListener('click', () => {
      const pre = $('sharePreview');
      pre.hidden = !pre.hidden;
      $('shareDetailsToggle').textContent = pre.hidden ? 'See exactly what gets sent' : 'Hide';
      if (!pre.hidden) refreshPreview(readLog().find((r) => r.night === state.nights[0]?.key));
    });

    $('removalBtn').addEventListener('click', async () => {
      $('shareStatus').textContent = 'Sending removal request…';
      const ok = await requestRemoval();
      state.shareEnabled = false;
      $('shareEnabled').checked = false;
      save();
      $('shareStatus').textContent = ok
        ? 'Sharing off, and removal requested. Your past reports will be deleted at the next cleanup.'
        : 'Sharing is now off, but the removal request could not be sent. Try again later.';
    });
  }

  $('exportBtn').addEventListener('click', () => {
    const rows = readLog();
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'whiff-log.csv';
    a.click();
    URL.revokeObjectURL(url);
  });

  // Recheck when the tab comes back into view — forecasts change through the day.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

function applySettingsToUI() {
  $('threshold').value = state.threshold;
  $('thresholdOut').textContent = `${state.threshold}%`;
  $('notifyEnabled').checked = state.notifyEnabled && ('Notification' in window) && Notification.permission === 'granted';
  $('nightStart').value = state.nightStartHour;
  $('nightEnd').value = state.nightEndHour;
  $('modelSelect').value = state.model;
}

load();
initMap();
wire();
applySettingsToUI();
if (state.site) setSite(state.site);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
