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

## 4. Copy the chart artwork from 24FlightBrief

The chart draws two vector layers you already own. From your `24Flightbrief`
repository, copy this folder into `24nav` at the same path:

```
maps/
```

The quickest route is to download the 24FlightBrief repo as a ZIP, pull
`public/maps` out of it, and drag that folder into **Upload files** on `24nav`
so it lands as `maps/`. Only `maps/coast.svg` and `maps/boundaries.svg` are
used right now; the per-airport `GROUND.svg` and `RWY_*.svg` files get used when
airport diagrams go in, so bring the whole folder.

Without `maps/`, the page still works. You get fixes, airports, airspace
sectors and the route, just no coastline underneath.

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

1. A brief power-up self test, then the cabin chime.
2. The chart with 24 airports, 112 fixes and 9 airspace sectors with their
   center frequencies.
3. A default IRFD to IPPH route. Click any cyan fix to append it. Select a fix
   in the left list first and the next click inserts after it. The × removes it.
4. Type a flight level into a fix row to force the profile through that altitude.
5. **Measure** for a drag-anywhere distance line with both reciprocal headings.
6. The profile strip: climb, cruise, descent, the 250 kt below 3000 ft envelope,
   and cloud decks once ATIS is wired in the next step.

Your route survives a refresh through `localStorage`. Nothing is stored
server-side yet.

## Known limitations at this step

- Airport labels for IBTH and IUFO overlap at full-world zoom because they sit
  31 map units apart. Zoom in and they separate. A label placement solver is not
  worth building yet.
- Cloud decks stay empty until the relay supplies ATIS.
- The overspeed warning is wired and tested but has no live traffic to watch
  yet. `Nav.alerts.evaluate(aircraft)` is the entry point the relay will call.
- Climb and descent gradients assume 3000 fpm at 250 kt and 2500 fpm at 280 kt
  on the game's speed scale, which works out to 1216 and 905 ft per NM. If your
  aircraft climb differently, change the two constants at the top of
  `js/profile.js`.
