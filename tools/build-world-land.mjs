#!/usr/bin/env node
"use strict";
/* Regenerates js/world-land.js from Natural Earth land polygons.

   Usage:
     node tools/build-world-land.mjs path/to/ne_50m_land.geojson [tolerance] [minArea]

   Get the input from the Natural Earth vector repo, e.g.
     https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
   (public domain, naturalearthdata.com).

   The output is a single string of SVG path data in a 4000-unit-wide Web-Mercator
   space (the same space `proj()` in js/trip-core.js uses), with one shape per
   polygon separated by "|". Holes (e.g. the Caspian Sea) stay inside their
   polygon's path and render correctly via the default nonzero fill rule.

   - tolerance: Douglas-Peucker simplification tolerance in projected units
     (1 unit ≈ 10 km at the equator). Default 1.2.
   - minArea: minimum ring area in projected units² below which islands/holes
     are dropped. Default 3. */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const [, , input, tolArg, areaArg] = process.argv;
if (!input) {
  console.error("usage: node tools/build-world-land.mjs <land.geojson> [tolerance] [minArea]");
  process.exit(1);
}
const TOL = tolArg ? Number(tolArg) : 1.2;
const MIN_AREA = areaArg ? Number(areaArg) : 3;
const MW = 4000, LAT_MAX = 84; // must match proj() in js/trip-core.js

function proj([lon, lat]) {
  lat = Math.max(-LAT_MAX, Math.min(LAT_MAX, lat));
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * MW, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * MW];
}

/* perpendicular distance² from p to segment a–b */
function segDist2(p, a, b) {
  let [x, y] = a;
  let dx = b[0] - x, dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

function douglasPeucker(pts, tol2) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let dMax = 0, iMax = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const d = segDist2(pts[i], pts[i0], pts[i1]);
      if (d > dMax) { dMax = d; iMax = i; }
    }
    if (dMax > tol2) { keep[iMax] = 1; stack.push([i0, iMax], [iMax, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function ringArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a / 2);
}

/* project, simplify, quantize to ints, drop degenerate/tiny rings */
function prepRing(ring) {
  let pts = douglasPeucker(ring.map(proj), TOL * TOL);
  const out = [];
  for (const p of pts) {
    const q = [Math.round(p[0]), Math.round(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  const first = out[0], last = out[out.length - 1];
  if (out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
  if (out.length < 3 || ringArea(out) < MIN_AREA) return null;
  return out;
}

/* compact SVG path: relative l/h/v with implicit command repetition */
function ringToPath(pts) {
  let d = "M" + pts[0][0] + " " + pts[0][1];
  let cmd = "M";
  const num = (n) => (n < 0 ? String(n) : (/[\d.]$/.test(d) ? " " : "") + n);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
    if (dy === 0) { d += (cmd === "h" ? "" : "h") + num(dx); cmd = "h"; }
    else if (dx === 0) { d += (cmd === "v" ? "" : "v") + num(dy); cmd = "v"; }
    else { d += (cmd === "l" ? "" : "l") + num(dx) + num(dy); cmd = "l"; }
  }
  return d + "z";
}

const gj = JSON.parse(readFileSync(input, "utf8"));
const polygons = [];
for (const f of gj.features) {
  const g = f.geometry;
  if (!g) continue;
  if (g.type === "Polygon") polygons.push(g.coordinates);
  else if (g.type === "MultiPolygon") polygons.push(...g.coordinates);
}

const shapes = [];
let ringsIn = 0, ringsOut = 0;
for (const rings of polygons) {
  ringsIn += rings.length;
  const outer = prepRing(rings[0]);
  if (!outer) continue;
  const parts = [ringToPath(outer)];
  for (let i = 1; i < rings.length; i++) {
    const hole = prepRing(rings[i]);
    if (hole) parts.push(ringToPath(hole));
  }
  ringsOut += parts.length;
  shapes.push(parts.join(""));
}

const body = shapes.join("|");
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "js", "world-land.js");
writeFileSync(
  outPath,
  '"use strict";\n' +
    "/* Simplified world coastlines, drawn in a 4000-unit-wide Web-Mercator space.\n" +
    '   Shapes are separated by "|" and rendered as individual SVG paths.\n' +
    "   Generated from Natural Earth land polygons (public domain) by\n" +
    "   tools/build-world-land.mjs — edit/rerun that script, not this file. */\n" +
    "const WORLD_LAND=" + JSON.stringify(body) + ";\n"
);
console.log(
  `wrote ${outPath}: ${shapes.length} shapes, ${ringsOut}/${ringsIn} rings kept, ` +
  `${(body.length / 1024).toFixed(1)} KiB path data (tolerance ${TOL}, minArea ${MIN_AREA})`
);
