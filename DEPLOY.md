# 24Nav step 2: live tracking, ATIS, guidance and the flight plan command

Still zero Vercel Functions, so you remain at 0 of 12 on the Hobby plan. All the
live data comes through your Universal Relay over one WebSocket.

## What changed in this build

**Runway selection was choosing the wrong end.** This is what made the runways
look backwards. The geometry was always right, and I verified it numerically:
with 25L selected the departure extension bears 247 and lands 0.2 NM from MOGTA,
and with 07L it bears 067 and lands 0.4 NM from LAVNO. The fault was the automatic
choice. It picked whichever end pointed nearest the straight line to the
destination, so IRFD to IPPH selected 07L purely because IPPH lies to the
north-east, sending the departure out over LAVNO.

Destination bearing has nothing to do with runway choice. Runways are now chosen
in the order a pilot would:

1. The runway the ATIS says is in use.
2. Into wind, if the ATIS reports a wind direction.
3. Only with no ATIS at all, the old track-aligned guess.

Each runway field now shows why it was chosen: **ATIS**, **wind**, **manual**, or
**no ATIS** in amber to flag that it is only a guess. A runway you pick by hand is
marked manual and will not be overridden by a later report; **Use ATIS runways**
hands control back. Changing the airport releases a manual choice, selecting the
same airport again keeps it.

The practical upshot: connect the relay and the runways follow the field. Without
ATIS you should expect to set them yourself, and the amber label tells you so.


**Waypoint clicking is fixed.** The cause was mine, not your upload. `chart.js`
called `svg.setPointerCapture()` on pointerdown, and pointer capture makes the
browser retarget the subsequent `click` event to the SVG root, so
`event.target.closest('.pick')` always returned null and nothing ever fired.
Selection now runs on `pointerup` against the element recorded at pointerdown,
which is the last target that can be trusted once capture is active. The `click`
listener is gone entirely.

My test suite passed all 110 checks against this bug because it stubbed
`setPointerCapture` as a no-op, so the click target stayed on the real element.
The suite now records capture and dispatches pointerup on the SVG root the way a
browser does, and dispatches no click at all, so anything depending on click
semantics fails in the test rather than in production.

**Route endpoints are runway thresholds.** Departure and arrival now sit on the
threshold of the runway in use rather than the airport reference point. Selecting
25L puts the departure on the 25L threshold, and the arrival sits on the landing
threshold, so distance, ETE, headings and the final approach are all measured
from where you actually leave and touch down. Endpoints read as `IRFD/25L` in the
route strip and along the profile axis, and changing the runway moves the endpoint
and updates the distance.

Verified against the dataset: from the 25L threshold, travelling along its
published heading of 247 reaches the 07R threshold, which confirms the threshold
coordinate is the start-of-roll end and that a departure extension continues
straight off the far end of the runway rather than doubling back. IBAR and IUFO
have no runway data, so those two fall back to the airport point.

**Also fixed:** the chart attribution line no longer intercepts clicks in the
bottom-right corner.

## Two things to fix in the repository first

**1. The chime was silent because of a filename mismatch.** Your repo has
`assets/audio/audio_aircraft-cabin-chime.mp3` and
`assets/audio/audio_777-master-warning.mp3`, but the old `app.js` asked for
`cabin-chime.mp3` and `master-warning.mp3`. A missing audio file fails inside the
play promise, so it failed quietly. The new loader tries every known filename in
turn, so either naming works and you do not have to rename anything.

**2. Delete the file called `download`.** It is still there in your latest upload. It is your `.gitignore` saved under the
wrong name, so nothing is actually being ignored. This build includes a proper
`.gitignore`; upload it and delete `download`.

## Allowed origins

Keep `ALLOWED_ORIGINS` exactly as you have it:

```env
ALLOWED_ORIGINS=https://24response.vercel.app,https://24nav.vercel.app
```

That is correct for two production sites. Only extend it if you start testing on
Vercel preview deployments or localhost, since those are different hostnames:

```env
ALLOWED_ORIGINS=https://24response.vercel.app,https://24nav.vercel.app,https://24nav-*.vercel.app,http://localhost:3000
```

Worth knowing when you test: opening `/v1/status` in a browser tab is a top-level
navigation and sends no `Origin` header, and `isOriginAllowed` returns true when
the origin is absent. That page loads even if the allowlist is wrong. Use the
**Test** button on the Live tab instead, which issues a real cross-origin fetch.

## Files

Add these new files, plus the whole `aircraft-icons/` folder:

```
js/runway-data.js
js/instruments.js
js/live.js
aircraft-icons/          (38 files)
```

Replace these:

```
index.html
js/app.js
js/chart.js
js/route.js
js/profile.js
styles/planner.css
styles/tokens.css
.gitignore
```

`js/map-data.js`, `maps/`, `assets/audio/`, `vercel.json` and `package.json` are
unchanged. On GitHub, **Add file > Upload files** and drag the whole tree in;
same-path files are overwritten and the commit covers everything at once.

## Relay setup

On Render, confirm the environment variable:

```env
ALLOWED_ORIGINS=*
```

Once it works you can narrow it, but it must include your Vercel origin exactly
and with no trailing slash:

```env
ALLOWED_ORIGINS=https://24nav.vercel.app,https://*.vercel.app,http://localhost:3000
```

The relay checks `Origin` on the WebSocket upgrade and browsers always send it,
so a mismatch here shows up as a connection that never opens.

In 24Nav, open the **Live** tab, paste your Render host into **Relay address**
and press **Connect**. A bare host is fine; the scheme and the `/v1/live` path
are added for you, and a pasted `/v1/live` is stripped. Because the site is
served over https the relay is always contacted over https and wss, so an
`http://` address is upgraded rather than failing as mixed content.

**Test** calls `/v1/status` and reports whether the relay can be reached at all,
which separates a CORS problem from a wrong address.

## Supabase

No schema changes this step. Nothing is written server side yet; saved plans and
automatic flight logging are the next step and the tables from `001_init.sql`
already cover them.

## Using it

**Adding waypoints.** This now works the way the DHL dispatch map does. Clicking a
fix opens a panel at the cursor showing the fix name and asking where it goes:
**Insert after [point]** or **Add to end**. It never guesses. Click a route point
on the chart, or a row in the route strip, to set the insertion point; the
selected point gets a dashed magenta halo. After each insert the insertion point
advances to the fix you just added, so clicking several fixes in a row builds the
route in order. Escape or a click away cancels.

Clicking an **airport** offers **Set departure** or **Set arrival** instead, since
airports are endpoints rather than route fixes.

If this felt broken before, it was: the old build drew fix symbols with
`fill: none`, so only the 1.25px stroke was clickable. Every symbol now carries an
invisible hit circle, 9 units for fixes and 11 for airports, and a click is
distinguished from a drag by measuring pixels moved rather than counting events.

**Aircraft icons.** Ported from your DHL dispatch map, including the same type
mapping, so an A330 gets the A330 silhouette and anything unrecognised falls back
to `c0.svg`. The artwork is the ADS-B Radar pack at 512 square, nose up, solid
black. Rather than a brittle tint chain it is forced white with
`brightness(0) invert(1)` and given a coloured glow: amber for the rehearsal
marker, green for a tracked live aircraft, red when the feed reports an emergency.
The licence requires a backlink, so there is a small credit in the bottom-right
of the chart. Leave it there.

**Track a flight.** Live tab, type a Roblox username or an in-game callsign, press
**Track**. **Use my callsign** takes whatever is on the Plan tab. The relay
matches on either and returns the aircraft, its filed plan and the ATIS for both
ends in one message. If the aircraft goes quiet for 15 seconds the instruments
release rather than freezing on stale data.

**Guidance.** The instruments are now positioned against the chart. Lateral sits
directly beneath it in the same grid column, so its deviation scale spans the
chart's width and its centre line falls on the chart's centre. Vertical is a tall
scale down the right-hand side, with the aircraft controls beneath it.

- Lateral reports the course, your track, how far off you are and which way to
  turn. The deviation bar deflects towards the course, the way a real one does,
  so a bar to the left means the track is to your left.
- Vertical steers to the next vertex on your planned profile, not to the next
  waypoint's altitude. On a direct route the next waypoint is the runway at
  surface level, so steering to it would demand a descent while you are still
  climbing. It shows what to make, how far you have, how far off plan you are,
  and the rate needed against the rate you selected. The needed rate turns red
  when it exceeds your selection by more than a quarter.

**Rehearse without a flight.** The Aircraft card has **Drop marker**. Drag the
aircraft around the chart and change its altitude to watch both instruments
respond. Tracking a live flight takes over automatically.

**Overspeed caution.** The button in the header is the annunciator. Dark when
clear. Flashing red with the master warning tone when you are above 250 kt below
3000 ft. Press it to acknowledge: the tone and the flash stop, the lamp stays
amber while the condition is still true, and it re-arms only after you have come
back inside the limit and broken it again. A changing airspeed does not restart
the tone.

**ATIS.** The ATIS tab shows both ends with the information letter, wind, QNH,
runways in use and the cloud layers. **Use ATIS runways** sets your planned
runways from the reports, skipping any runway that is not in the runway database.
Cloud layers feed straight into the vertical profile as shaded decks, so you can
see your cruise sitting inside an overcast deck.

**Flight plan command.** Plan tab. Fill in the in-game callsign, aircraft and
Roblox username, then **Copy**. The command is the ATC24 syntax:

```
/createflightplan ingamecallsign:… callsign:… aircraft:… flightrules:IFR
departing:… arriving:… flightlevel:… ingamename:… route:…
```

The in-game callsign and the filed callsign stay separate throughout, as you
asked. Leave the filed one blank and it reuses the in-game one. Only named fixes
go in `route:`; runway extensions are local geometry and are left out.

**Load a filed plan.** When you are tracking a flight that has filed through the
bot, the Live tab offers **Load into planner**. It takes the endpoints, cruise
level, callsigns and any route fixes that exist in the chart database, and tells
you which fixes it could not resolve instead of silently giving you a shorter
route.

**Runway extensions.** Route tab, turn one on, then drag its diamond along the
centreline on the chart. Drag it back onto the threshold to switch it off. The
departure leg starts at the far end of the runway and runs out on the departure
heading; the arrival leg starts at the threshold and runs back down the approach.
Capped at 20 NM.

**Waypoint altitudes.** Every waypoint now carries the altitude you should be at,
shown in the route strip and on the profile. Type a flight level into a fix to
make it a hard constraint and the profile bends through it. On a direct route the
altitudes come purely from your climb and descent rates.

## Known limits

- Flight plans only exist in the relay if they were filed while it was connected.
  After a Render restart, refile. Tracking by username still works from telemetry.
- Free Render instances sleep. The first connection after idle can take half a
  minute; the client backs off and retries on its own.
- Airport labels for IBTH and IUFO overlap at full-world zoom. Zoom in.
- The 67 ground overlays are full-extent images. If panning stutters, turn
  **Airport ground** off.
- Climb and descent gradients are derived from your selected rates on the game's
  speed scale, where an aircraft indicating 280 kt crosses the ground at 166 kt.
  Constants are at the top of `js/profile.js`.
