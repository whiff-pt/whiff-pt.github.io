# Whiff 👃

### → **[lrcarey222.github.io/whiff](https://lrcarey222.github.io/whiff/)**

**Will you smell the Port Townsend paper mill tonight?**

Enter your address, get a probability for tonight and the next few nights, and
get a push notification when it clears a threshold you set.

Nothing is stored on any server — your address lives in your own browser and
never leaves it except as a coordinate lookup. On a phone, "Add to Home Screen"
installs it as a standalone app.

No API keys, no build step, no backend. Weather comes from
[Open-Meteo](https://open-meteo.com) and geocoding from
[Nominatim](https://nominatim.org), both free and CORS-enabled.

---

## Deploying and sharing

The live site is GitHub Pages serving `main` from the repository root. Any push
to `main` redeploys it within a minute or two — there is no build step, so what
is in the repo is what is on the web.

```bash
git push          # that's the whole deploy
```

Returning visitors pick up changes immediately: the service worker is
network-first for same-origin files, so it never serves a stale app.

### Before sharing it widely

Geocoding uses [Nominatim](https://operations.osmfoundation.org/policies/nominatim/)
and the map uses [OSM tiles](https://operations.osmfoundation.org/policies/tiles/).
Both are donated infrastructure with usage policies aimed at exactly this scale
— one small town's worth of traffic is fine, a link that goes properly viral is
not. If it takes off, move geocoding to Photon or a keyed provider and tiles to
a paid host. The map-pin fallback means the app still works if geocoding is
throttled.

## Run it locally

```bash
npm start
```

Then open <http://localhost:5173>. (It must be served over HTTP — ES modules and
service workers don't work from `file://`.)

```bash
npm test          # model sanity tests
npm run notify:dry  # score tonight for everyone in the config, print, send nothing
```

---

## How the model works

The mill sits at **48.094076, −122.796979** (100 Mill Rd, Glen Cove — the
coordinates on its [Dept. of Ecology facility
record](https://apps.ecology.wa.gov/facilitysite/FacilitySite/FacilitySiteReport?FacilitySiteId=34516979)).
Weather is queried once at the mill, since the plume's fate is decided at and
just downwind of the source and the whole town fits inside one forecast grid
cell.

Every forecast hour in your night window gets an **exposure index**, the product
of seven factors. Each is 0–1 (or a multiplier around 1), so any one of them can
veto the night on its own:

| Factor | What it captures |
|---|---|
| **Downwind alignment** | Angle between the plume's travel direction and the bearing from the mill to you, as a Gaussian with σ ≈ 30–75°. Wide on purpose: PT's winds shift hour to hour where the strait, the bay and Discovery Bay meet, and a model's 10 m wind direction is only good to ±20–30° at this lead time. |
| **Decoupling** | When the wind is light *and* the boundary layer has collapsed to a few tens of metres, the 10 m wind direction stops describing anything real — the surface layer detaches, drainage off the Quimper hills takes over, and the plume snakes through a wide sector. A pooling baseline then overrides alignment. Both conditions are required: 1.5 m/s under a 400 m mixed layer is still a direction; 1.5 m/s under a 45 m layer is not. |
| **Distance** | `1 / (1 + (km/4)^1.6)` — half strength at 4 km, still material at 10. |
| **Wind speed** | Gaussian peaked at 2.6 m/s. Dead calm doesn't deliver; a gale shreds the plume. |
| **Stability** | The main nighttime mechanism. Blends the 1000 hPa and 925 hPa temperatures against the 2 m temperature (inversion strength), boundary-layer height, wind speed, and clear-sky radiative cooling. |
| **Fog & humidity** | Reduced sulfur compounds partition into fog droplets and sit at nose level; fog also implies a shallow saturated layer. Driven by forecast visibility and RH. |
| **Rain washout** | `exp(−mm/1.5)`. Drizzle barely matters; real rain scrubs the air. |
| **Cold-air pooling** | Low-lying, shoreline addresses collect drainage flow and heavy gases. Uses your ground elevation. |

The index goes through a logistic to become an hourly probability. Hours in one
night are then combined with a **damped noisy-OR** — twelve consecutive bad
hours are not twelve independent chances, so successively less-severe hours are
discounted by 0.35 each.

This matches what the Dept. of Ecology and the mill have both pointed to as the
driver of complaint spikes: high pressure, low winds, and cool autumn nights,
with odor compounds heavy enough to sit low. It is *not* a dispersion model and
carries no plume chemistry.

### Calibration — read this before you trust a number

**The constants are physically reasoned, not fitted to observed odor reports.**
Nobody has published a Port Townsend odor dataset to fit against. Treat the
output as a well-argued ranking of nights, not a validated probability.

**Check it against a night you remember.** `hindcast.mjs` pulls the archived
model run for a past date and scores it, with the full hour-by-hour breakdown
and the surrounding nights for context:

```bash
node notifier/hindcast.mjs --date 2026-08-31 --address "1313 Logan St"
```

The useful question is rarely "what number did it give?" but "did it rank the
bad night above the ordinary ones, *and for the right reason?*" — so read the
hourly rows, not just the headline.

### The one night this has actually been checked against

**31 Aug 2026, 1313 Logan St** (1.7 km due north of the mill) — reported as the
worst odor event of the season, and confirmed by the resident as arriving
**after midnight**, not during the evening. The model scores it **79%, ranked
1st of the 9 nights** in that window.

It is also what produced the decoupling term. The nominal wind was WNW all
night, pointing the plume away, and the first version scored eleven of the
twelve hours at 2% — taking its whole night score from a single 06:00 wind
shift. Right answer, wrong mechanism. The real event was stagnation: winds under
2 m/s beneath a 35–80 m boundary layer with a +2.3 °C inversion and 94% RH. The
night is pinned in `test/model.test.mjs` with the confirmed timing.

That is **one** labeled night, and it is a positive. The model's likelier
failure mode is false positives on calm nights that turned out fine, and
nothing here tests for that yet — which is what the nightly log below is for.

The app also closes the loop prospectively. Each night you can log whether you
smelled anything **and roughly when** — the time band is the single most
informative column, because an evening report and a pre-dawn one implicate
different mechanisms. The log lives in your browser and exports as CSV.

Once you have thirty-odd nights covering both smelly and clean conditions:

```bash
node notifier/calibrate.mjs whiff-log.csv
```

It maximum-likelihood-fits the two free constants (`e50`, `k` in
`src/model.js`), reports the improvement over the current defaults, and prints a
reliability table — observed odor rate per forecast bucket. If the fit isn't
meaningfully better than the defaults it tells you to leave them alone.

## Shared logging

One person's log is thirty anecdotes. Thirty people's logs are a dataset — and
nobody has published one for this mill, which is the main reason the model
can't be properly calibrated today. Shared logging is the opt-in that turns the
first into the second.

**It is off until you configure a backend**, and the sharing UI stays hidden
entirely. The app is local-only out of the box.

### Setting it up

1. Create a free [Supabase](https://supabase.com) project.
2. Paste `supabase/schema.sql` into its SQL editor and run it once.
3. Put the project URL and the **anon** key into `src/share-config.js`, commit,
   push. That's it.

The anon key is public by design — it ships in the JavaScript of every Supabase
web app. It is safe here because the schema grants it **insert and update only,
with no read policy at all**. Someone who takes the key from your source can add
rows; they cannot read a single one, so they cannot learn who reported what.
The `service_role` key is the one that matters — keep it in your shell, never in
this repo.

### What a contributor actually sends

```json
{
  "install_id": "15eb67a1-4485-4ca9-bc85-02904d4089a9",
  "night": "2026-09-02", "smell": 2, "smell_window": "predawn",
  "dist_km": 1.75, "bearing_deg": 0, "elevation_m": 80,
  "predicted": 0.709, "peak_hour": 21, "wind_dir": 199, "wind_speed": 2.75,
  "alignment": 0.852, "stability": 0.598, "moisture": 0, "decoupled": 0,
  "model_version": "0.2.0"
}
```

The design rules, which the UI states plainly and a "see exactly what gets sent"
button proves:

- **The street address never leaves the browser.** Location goes as distance and
  bearing from the mill, rounded to 0.25 km and 10° — about a 250 × 520 m cell at
  3 km. That is a neighbourhood, not a house, and it is all the model consumes.
- **No name, no email, no account.** Identity is a UUID generated on the device.
- **Nothing retroactive.** Switching sharing on shares tonight onward. A month of
  private logs stays private — that month was not consented to.
- **Incomplete reports are withheld.** A smell with no time band isn't sent,
  because a row missing the most valuable column dilutes the table.
- **Removal is a request, not a button.** Anon can't delete rows — otherwise
  anyone who learned an install ID could erase someone's history. The app files
  a request; you action it with the query in `schema.sql`.

### Reading the dataset

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_KEY=eyJ... \
  node notifier/pull-observations.mjs > observations.csv
```

CSV to stdout, a summary to stderr — contributor count, smelly-vs-clean split,
how many reports carry a time band, and a warning if model versions are mixed
(probabilities from different versions are not comparable). `install_id` is
fetched for the contributor count but deliberately never written to the CSV, so
the working dataset carries no key linking one person's nights together.

Then feed it straight to the fitter, which reads either CSV format:

```bash
node notifier/calibrate.mjs observations.csv
```

To check the model still discriminates across the peninsula:

```bash
node notifier/sweep.mjs
```

That prints a neighbourhood × night grid. If every cell reads 90% or every cell
reads 5%, `e50` needs moving.

---

## Notifications

Two mechanisms, because browsers are bad at this:

**In the app** — tick "Show a notification on this device". It fires when the
page is open or when you reopen it. That's the ceiling for a backend-less web
app; there is no way to make a browser wake up on its own at 4pm.

**The notifier script** — this is the one that actually reaches your phone.

```bash
cp notifier/config.example.json notifier/config.json
```

Edit it: set an unguessable `ntfyTopic`, and add a subscriber with the `lat`,
`lon` and `elevationM` the web app shows for your address. Then install
[ntfy](https://ntfy.sh) on your phone (free, no account, iOS and Android) and
subscribe to that same topic.

```bash
node notifier/notify.mjs --dry-run --force   # see what it would send
node notifier/notify.mjs                     # send if over threshold
```

Topics on the public ntfy.sh server are readable by anyone who guesses the
name, so pick something long. Set `ntfyServer` if you self-host. A generic
`webhook` field is also supported for Slack, Discord, Home Assistant or IFTTT.

### Run it every afternoon

**GitHub Actions** — `.github/workflows/nightly-whiff.yml` is already live on
this repo. It runs at 22:00 UTC (3pm Pacific in summer, 2pm in winter) and
currently skips itself, because the config secret doesn't exist yet. To turn it
on, fill in `notifier/config.json` and upload it as a secret:

```bash
gh secret set WHIFF_CONFIG_JSON < notifier/config.json
```

Then check it works without waiting for the schedule:

```bash
gh workflow run nightly-whiff.yml -f force=true
```

Two things to know about Actions cron: it is best-effort and can run late by
tens of minutes under load, and GitHub disables scheduled workflows on a repo
with no commits for 60 days (it emails first).

**Windows Task Scheduler**

```bash
schtasks /create /tn "Whiff" /tr "node C:\path\to\whiff\notifier\notify.mjs" /sc daily /st 15:00
```

**cron**

```bash
0 15 * * * cd /path/to/whiff && /usr/bin/node notifier/notify.mjs >> whiff.log 2>&1
```

---

## Layout

```
index.html            UI
styles.css
src/model.js          the whole forecast model — pure, no DOM, no network
src/weather.js        Open-Meteo + Nominatim
src/app.js            UI wiring, Leaflet map, feedback log
sw.js                 service worker (installable, offline shell)
notifier/notify.mjs   scheduled push
notifier/hindcast.mjs   score a past night from the archive
notifier/sweep.mjs    neighbourhood × night calibration grid
notifier/calibrate.mjs  fit e50/k to your exported log
test/model.test.mjs   node --test
```

`src/model.js` is imported unchanged by both the browser app and the Node
notifier, so the two can never disagree about a forecast.

---

## Caveats

- **No terrain.** Morgan Hill, Castle Hill and the bluffs really do channel and
  block the plume; the model only knows your elevation, not what's between you
  and the mill.
- **Elevation is used only for pooling, never for escape.** On the worst nights
  the boundary layer collapses below 50 m, which puts hillside addresses
  *above* the trapped layer — they should smell less, not more. The model
  doesn't represent that, partly because the elevation itself comes from a 90 m
  DEM that is unreliable at street scale.
- **No mill operations data.** Emissions are not constant — upsets, lime kiln
  and recovery boiler cycles, and maintenance all matter, and none of it is
  public in real time. The model assumes a steady source.
- **One weather grid cell.** Local sea breezes and drainage winds inside Port
  Townsend are finer than any available forecast. The HRRR option (3 km, 2 days)
  is the sharpest on offer.
- **Nominatim** asks for no more than one geocode per second. Fine for a person,
  not for a public deployment with real traffic — swap in your own geocoder if
  this gets popular.

Not affiliated with Port Townsend Paper Co., the Dept. of Ecology, or ORCAA.
To report an actual odor event, call ORCAA at **1-800-422-5623** — a prediction
is not a complaint, and only complaints show up in the regulatory record.
