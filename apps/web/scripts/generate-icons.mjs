// Install icons (MP3 §1, #377), derived from public/favicon.svg.
//
// Run by hand, outputs checked in:
//
//     node apps/web/scripts/generate-icons.mjs
//
// Checked-in rather than build-time because the only rasteriser this repo
// already owns is Playwright's Chromium, and that browser is downloaded in
// exactly one CI leg (the e2e one) — a `vite build` that needed it would make
// the build depend on a browser install the build job does not do, to
// re-derive four files from art that changes approximately never. The script
// is the reproducible part; the PNGs are its committed output. Re-run it and
// commit the diff whenever favicon.svg changes.
//
// The source art is single-sourced from favicon.svg: the plate and the flame
// are read back out of it, not restated here, so a retint of the favicon
// reaches the install icons through one command.

import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(webRoot, "public", "favicon.svg");
const outDir = path.join(webRoot, "public", "icons");

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

/**
 * The four variants. `plate` picks the shape behind the flame:
 *
 *  • "art" reproduces favicon.svg as-is — the rounded plate on a transparent
 *    ground. That is the `purpose: any` icon, shown as drawn.
 *  • "bleed" fills the whole square and centres the flame in it. Both consumers
 *    of this shape mask the square themselves — Android's maskable spec crops
 *    to an arbitrary shape inside the central 80%, iOS rounds the home-screen
 *    icon with its own superellipse — so a pre-rounded plate would either show
 *    its corners cut twice or leave transparent wedges outside the mask.
 *
 * `flame` is the flame's longest side as a fraction of the square. 0.56 keeps
 * the mark inside the maskable safe circle with its diagonal to spare (the
 * art's own proportion, which is where the number comes from); iOS crops far
 * less, so its icon can afford to sit larger.
 */
const VARIANTS = [
  // 96 is the conventional size for a manifest `shortcuts` icon — the row of
  // entries under a long-pressed launcher icon. Same drawing as the app icon,
  // because they are the same app.
  { file: "icon-96.png", size: 96, plate: "art" },
  { file: "icon-192.png", size: 192, plate: "art" },
  { file: "icon-512.png", size: 512, plate: "art" },
  { file: "icon-maskable-512.png", size: 512, plate: "bleed", flame: 0.56 },
  { file: "apple-touch-icon.png", size: 180, plate: "bleed", flame: 0.62 },
];

/** `<path d="…" fill="…"/>` in document order — the plate, then the flame. */
function paths(svg) {
  return [...svg.matchAll(/<path\s[^>]*\/?>/g)].map(([tag]) => ({
    d: /\sd="([^"]+)"/.exec(tag)?.[1] ?? "",
    fill: /\sfill="([^"]+)"/.exec(tag)?.[1] ?? "none",
  }));
}

const svg = await readFile(source, "utf8");
const [plate, flame] = paths(svg);
if (!plate || !flame) {
  throw new Error(`${source}: expected a plate path and a flame path`);
}
const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
if (!viewBox) {
  throw new Error(`${source}: no viewBox`);
}
const [minX, minY, width, height] = viewBox.split(/\s+/).map(Number);

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(
  `<style>html,body{margin:0;background:none}</style>
   <svg id="probe" ${SVG_NS} viewBox="${viewBox}"><path d="${flame.d}"/></svg>`,
);
// Measured rather than eyeballed: the flame is an arbitrary path, and its
// bounding box is what the centring and the safe-zone fraction are both
// expressed against.
const box = await page.locator("#probe path").evaluate((path) => {
  const { x, y, width, height } = path.getBBox();
  return { x, y, width, height };
});

await mkdir(outDir, { recursive: true });
for (const variant of VARIANTS) {
  await page.setViewportSize({ width: variant.size, height: variant.size });
  await page.setContent(
    `<style>html,body{margin:0;background:none}svg{display:block}</style>
     <svg ${SVG_NS} viewBox="${viewBox}" width="${variant.size}" height="${variant.size}">
       ${body(variant)}
     </svg>`,
  );
  await page.locator("svg").screenshot({
    path: path.join(outDir, variant.file),
    omitBackground: true,
  });
  console.log(`${variant.file} (${String(variant.size)}px)`);
}
await browser.close();

function body(variant) {
  if (variant.plate === "art") {
    return `<path d="${plate.d}" fill="${plate.fill}"/>
            <path d="${flame.d}" fill="${flame.fill}"/>`;
  }
  const scale =
    (variant.flame * Math.min(width, height)) / Math.max(box.width, box.height);
  const tx = minX + width / 2 - scale * (box.x + box.width / 2);
  const ty = minY + height / 2 - scale * (box.y + box.height / 2);
  return `<rect x="${String(minX)}" y="${String(minY)}" width="${String(width)}" height="${String(height)}" fill="${plate.fill}"/>
          <g transform="translate(${String(tx)} ${String(ty)}) scale(${String(scale)})">
            <path d="${flame.d}" fill="${flame.fill}"/>
          </g>`;
}
