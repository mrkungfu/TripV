# Trip visualizer

An interactive, dependency-free trip visualizer: an animated world map, a space–time
"journey" chart, a calendar, and a searchable itinerary — driven entirely by a JSON
config so it works for **any** trip, plus an editor page for building and maintaining
those configs.

No build step, no server-side anything. Open the pages in a browser (or host the
folder as static files):

| Page | What it does |
|---|---|
| `index.html` | The viewer. Loads the active saved trip, or the bundled fictional demo. You can also drag-and-drop a `.trip.json` file onto it. |
| `editor.html` | Create/edit trip configs: validate, format, import/export files, manage the trips saved in your browser, and convert pasted TripIt-style itinerary text (flights, buses/transfers, lodging, activities and their notes) into a draft config. |

> Tip: browsers are happiest when the pages are served over HTTP. From this folder:
> `python3 -m http.server 8000` then open <http://localhost:8000/>.

## Privacy model

No trip data is baked into the pages. The bundled demo trip (`js/demo-trip.js`) is
fictional. Your real trips live in your browser's `localStorage` (and in any files you
export) — they are never embedded in the published HTML, so you can host the tool
publicly without publishing your bookings, door codes or addresses.

## The config format

One JSON object. Times are ISO 8601 **with an explicit UTC offset** (that's what makes
all the timezone math work without a timezone database). Full field-by-field docs live
in the editor's **Schema help** tab; the short version:

```jsonc
{
  "title": "Seattle → Japan → Korea → Home",
  "places": {                    // keyed by a short id you invent
    "sea": {"n":"Seattle","r":"Washington, USA","cc":"USA",
            "lat":47.6062,"lon":-122.3321,"off":-420}
    //      off = UTC offset in MINUTES during your visit
    //      optional: "c" (hex colour), "lbl" ([dx,dy,anchor,zoomTier] label placement)
  },
  "legs": [                      // the spine — each leg starts where the last ended
    {"mode":"flight","from":"sea","to":"tyo",
     "dep":"2026-09-05T10:45:00-07:00","arr":"2026-09-06T13:10:00+09:00",
     "title":"SEA → NRT","op":"Example Air 810","warn":"…","det":"…"}
    // modes: flight · bus · car · train · ferry · gap (gap = unbooked stretch, drawn dashed)
  ],
  "stays": [                     // lodging; lat/lon optional (pins appear at street zoom)
    {"place":"tyo","name":"Shinjuku Garden Hotel","addr":"…",
     "in":"2026-09-06T15:00:00+09:00","out":"2026-09-10T11:00:00+09:00","det":"…"}
  ],
  "events": [                    // kind: activity | note | gapnote
    {"kind":"activity","place":"tyo","title":"teamLab Planets",
     "start":"2026-09-08T17:00:00+09:00","end":"2026-09-08T19:00:00+09:00",
     "lat":35.649,"lon":139.789,"addr":"Toyosu","warn":"…","det":"…"}
  ],
  "focus": ["tyo","kyo"],        // optional: what the map's Focus button fits
  "calendarOffset": 540          // optional: which clock defines a calendar "day"
}
```

The editor also accepts a relaxed JS object literal (unquoted keys, trailing commas),
so data lifted out of an old `<script>` block pastes straight in — hit **Format** to
normalize it to JSON.

## How map locations are determined

Nothing is geocoded — the map only ever draws coordinates that are in the config:

- **Places** are the anchor: every place needs an explicit `lat`/`lon` (decimal
  degrees), and those drive the city dots, the labels, and both ends of every leg.
- **Legs — including buses** — are drawn as a great-circle line between the `from`
  and `to` places' coordinates, colored by mode. A bus is *not* routed along roads
  and a train not along tracks; it's a straight chord on the (Mercator) map, exactly
  like a flight. The animated traveler dot interpolates along that same line.
- **Stays** pin at their own `lat`/`lon` if given, otherwise at their place's
  coordinates. **Events** only get a pin when they carry an explicit `lat`/`lon`.
  Both appear at street-level zoom.

The paste importer fills coordinates from two built-in lookup tables in
`js/trip-core.js`: `AIRPORTS` (major IATA codes) for flights, and `CITIES`
(European + a few world cities, with local-name aliases like München/Wien/Roma)
for everything else. Bus, car and transfer endpoints are matched by scanning the
station name / street address text for a known city name, so a "FlixBus —
Frankfurt Airport → …Heidelberg…" leg lands on Frankfurt and Heidelberg city
coordinates. Anything the importer can't match is created with `lat: 0, lon: 0`
and called out in the import report so you can fill it in by hand.

### Migrating a trip out of the old single-file page

The schema intentionally matches the old page's inline `PLACES` / `LEGS` / `STAYS` /
`EVENTS` structures. Paste them into the editor's Config tab as:

```js
{ title:"…", places:{ …PLACES… }, legs:[ …LEGS… ], stays:[ …STAYS… ], events:[ …EVENTS… ] }
```

then Validate, name, and save. (The old per-place `LBL` map is now an optional `lbl`
array on each place.)

## Files

```
index.html         viewer page (markup + styles)
editor.html        editor page (markup + styles + schema docs)
js/viewer.js       viewer app — renders whatever config is loaded
js/editor.js       editor app — validation UI, trip library, text import
js/trip-core.js    shared: helpers, schema normalization/validation, model
                   building, localStorage library, itinerary-text importer
js/demo-trip.js    the fictional bundled demo trip
js/world-land.js   simplified world coastline data (Mercator, 4000-unit space),
                   generated from Natural Earth land polygons (public domain)
tools/build-world-land.mjs
                   regenerates js/world-land.js from a Natural Earth GeoJSON file
                   (see the header comment for usage and the data source URL)
```

## Bugs fixed while generalizing

The original single-file page had several issues that are fixed here:

- **Hardcoded dates everywhere**: the calendar months, the journey chart's month/week
  grid, and the scrubber's month ticks were all hardcoded to Jul–Oct 2026. They are
  now derived from the trip's actual time window.
- **Hardcoded timezones**: day boundaries used a baked-in UTC+2 and day numbering a
  baked-in Phoenix offset. Both now come from the trip data (`calendarOffset` defaults
  to the offset where the most time is spent; day numbers anchor to the origin's clock).
- **Antimeridian smear**: a route crossing ±180° longitude (e.g. Seattle → Tokyo, as in
  the new demo) drew a line right across the map. Route paths now split at the
  antimeridian.
- **Unescaped HTML in tooltips/labels**: leg titles/operators in the journey-chart
  tooltip (and several other interpolations) were inserted without escaping, breaking
  on `&`/`<` and unsafe with untrusted configs. All user data is now escaped.
- **Duplicate event listeners**: `buildCalendar()`/`buildChapters()` re-registered
  click/hover handlers on every rebuild. Handlers are now bound once and delegated,
  which matters now that trips can be switched at runtime.
- **Hidden-map resize corruption**: resizing while on the Calendar/Journey tab ran the
  fit math against a 0×0 rect, producing an `Infinity` viewBox. Fitting is now deferred
  until the map is actually visible.
- **Scrubber max mismatch**: the HTML said `max="1000"` while the JS used 10000 (a
  momentary wrong position before JS ran). Now consistent.
- **Division by zero** in the journey chart when a trip has fewer than two places, and
  a spread-on-empty crash when a config has no events/stays — both guarded.
- **Dead code / markup**: unused `dayKeyList()`, a stray `j-hitm` class, a pointless
  `/1`, and the missing `</html>` are cleaned up.
- **"In town" readout** could show a hotel from a different city when stays overlapped
  a transit stop; it now also matches on the current place.
