# 24Nav deployment, step 1

Route planner, chart editor, distance tool and vertical profile. No API
functions yet, so nothing here can break your Vercel function count. Auth,
the relay and flight logging land in the next steps.

## 1. Create the repository

GitHub, **New repository**, name it `24nav`. Do not add a README or a
`.gitignore`; the files below include one.

## 2. Add the text files

For each file, use **Add file > Create new file**. Type the full path into the
filename box, including the folder. Typing `js/chart.js` creates the `js`
folder automatically. Paste the contents, then **Commit changes**.

```
index.html
vercel.json
package.json
.gitignore
DEPLOY.md
styles/tokens.css
styles/planner.css
js/map-data.js
js/chart.js
js/route.js
js/profile.js
js/app.js
supabase/001_init.sql
```

Order does not matter. If you would rather do it in one shot, use
**Add file > Upload files** and drag the whole folder tree in; GitHub keeps the
folder structure.

## 3. Add the two audio files

These are binary, so they cannot be pasted as text. Use
**Add file > Upload files**, then drag both files in and set the path by
dragging them into an `assets/audio` folder, or upload them and rename to:

```
assets/audio/cabin-chime.mp3
assets/audio/master-warning.mp3
```

`cabin-chime.mp3` plays when the self test finishes. `master-warning.mp3` plays
on the overspeed warning.

## 4. Add the chart artwork

The `maps/` folder ships with this build, so there is nothing to copy out of
24FlightBrief. Use **Add file > Upload files** and drag the whole `maps` folder
in at once. It is 240 files and about 4 MB, and GitHub preserves the structure.

If you already have `maps/` in the repository from an earlier attempt, uploading
again simply overwrites identical files.

These files are authored for a light background: land is `#333333`, aprons and
taxiways are `#000000`, and every outline is stroked in `#000000`. That is why
they looked missing on a dark chart. The stylesheet now inverts them, the same
way your FlightBrief radar view does. Brightness is controlled by the `opacity`
values on `.chart-base`, `.airport-ground` and `.airport-runway` in
`styles/planner.css` if you want them louder or quieter.

## 5. Connect Vercel

Vercel, **Add New > Project**, import `24nav`.

- Framework preset: **Other**
- Build command: leave empty
- Output directory: leave empty
- Install command: leave empty

Deploy. There is no build step, so it finishes in seconds.

## 6. Supabase

Nothing on the page reads Supabase yet, so this step is preparation. Run it now
so the schema is stable before flight logging is written against it.

1. Supabase dashboard, **SQL Editor**, **New query**.
2. Paste all of `supabase/001_init.sql` and **Run**. It is safe to re-run.
3. Check **Table Editor** for `profiles`, `flight_plans`, `flight_logs`,
   `flight_log_events` and `atis_snapshots`.
4. **Project Settings > API**. Copy the **Project URL** and the
   **service_role** secret.
5. Vercel, **Settings > Environment Variables**, add for Production:

```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SECRET_KEY=<service_role secret>
```

Do not put the service_role key anywhere the browser can reach. Every table has
row level security on with no permissive policies, so the anon key can read
nothing even if it leaks. Server functions use the secret key, which bypasses
RLS.

### Retention

`purge_feed_identifiers()` strips feed-sourced Roblox usernames from logs older
than 14 days, which is what the 24data terms require. Schedule it once:

```sql
select cron.schedule('purge-feed-identifiers', '0 4 * * *',
  $$select public.purge_feed_identifiers()$$);
```

If `pg_cron` is not enabled, enable it under **Database > Extensions** first, or
skip this and have the relay call the function on a timer in the next step.

## What you should see

1. A power-up self test, then an **Enter Flight Deck** button. Clicking it plays
   the cabin chime and opens the planner. The chime rides on that click on
   purpose: browsers refuse to play audio without a user gesture, which is why
   it was silent before.
2. The chart with the coastline, airspace boundaries, airport grounds and runway
   markings, plus 24 airports, 112 fixes and 9 sectors with their center
   frequencies.
3. A default IRFD to IPPH route. Click any cyan fix to append it. Select a fix
   in the left list first and the next click inserts after it. The × removes it.
4. Type a flight level into a fix row to force the profile through that altitude.
5. **Measure** for a drag-anywhere distance line with both reciprocal headings.
6. **Airport ground** toggles the 67 ground and runway overlays off if you want
   a clean enroute picture.
7. **Hide** on the profile bar collapses the vertical profile. The choice is
   remembered.

Your route survives a refresh through `localStorage`. Nothing is stored
server-side yet.

## What this step fixed

- Text no longer highlights when you drag across the chart, and right-clicking
  the chart or the profile no longer opens the browser menu.
- The coast, boundaries, airport grounds and runways now render. They were always
  loading; they were black artwork on a black chart.
- The chart viewBox is now locked to its container aspect with a ResizeObserver,
  so the map fills the panel instead of floating in dead space. The initial
  measurement used to run before layout had settled.
- The shell uses `100dvh` and the profile is height-clamped to 21vh, so
  everything fits at 100% zoom. The collapse button covers short screens.
- The chime plays reliably, on the entry click.

## Still to come

- Live traffic. Needs the relay, which is the next step.
- Discord OAuth and saved plans. Step after that.
- Cloud decks stay empty until the relay supplies ATIS. The parser is written and
  tested against real ATIS bodies, including the case where `DEP RWY 26` must not
  be mistaken for a cloud layer.
- The overspeed warning is wired and tested but has nothing to watch yet.
  `Nav.alerts.evaluate(aircraft)` is the entry point the relay will call.

## Known limitations

- Airport labels for IBTH and IUFO overlap at full-world zoom because they sit
  31 map units apart. Zoom in and they separate.
- Climb and descent gradients assume 3000 fpm at 250 kt and 2500 fpm at 280 kt
  on the game's speed scale, which works out to 1216 and 905 ft per NM. Change
  the two constants at the top of `js/profile.js` if your aircraft differ.
- The 67 airport overlays are full-extent images, so heavy panning on a slow
  machine may stutter. Turn **Airport ground** off if it does.
