// Tray icons (MX3 §6, #304), derived from the web app's `public/favicon.svg`.
//
// Run by hand, outputs checked in:
//
//     pnpm --filter @emberchat/desktop tray-icons
//
// The same deal `apps/web/scripts/generate-icons.mjs` strikes, for the same
// reasons: the only rasteriser this repo owns is Playwright's Chromium, which
// exactly one CI leg downloads, and these four files re-derive from art that
// changes approximately never. The script is the reproducible part; the PNGs
// are its committed output. Nothing in the desktop *build* reads `apps/web` —
// that would be spec invariant 2 — but a hand-run generator single-sourcing
// the mark is better than a second copy of the artwork living here.
//
// Two pictures, because the two platforms want different ones:
//
//  • macOS menu bar: a **template image** — black plus alpha, which the OS
//    tints for light mode, dark mode and a selected menu. The plate cannot
//    survive that (a black square is not an icon), so the template is the
//    flame's silhouette alone, scaled to fill the bar's usable height.
//  • Windows notification area: the app's own artwork, plate and all. The
//    taskbar can be light or dark and the plate is what keeps the mark legible
//    on both.
//
// Both at 1x and 2x — Electron's `nativeImage` picks up the `@2x` file beside
// the one it was given, by name.

import { chromium } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.resolve(desktopRoot, "..", "web", "public", "favicon.svg");
const outDir = path.join(desktopRoot, "assets");

const SVG_NS = 'xmlns="http://www.w3.org/2000/svg"';

/**
 * `flame` is the flame's longest side as a fraction of the square; the
 * silhouette gets the room the plate used to take, minus a hair of padding so
 * it does not touch the menu bar's edges.
 */
const VARIANTS = [
  { file: "trayTemplate.png", size: 16, style: "template", flame: 0.86 },
  { file: "trayTemplate@2x.png", size: 32, style: "template", flame: 0.86 },
  { file: "tray.png", size: 16, style: "art" },
  { file: "tray@2x.png", size: 32, style: "art" },
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
// bounding box is what the centring and the fill fraction are expressed
// against.
const box = await page.locator("#probe path").evaluate((node) => {
  const { x, y, width, height } = node.getBBox();
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
  if (variant.style === "art") {
    return `<path d="${plate.d}" fill="${plate.fill}"/>
            <path d="${flame.d}" fill="${flame.fill}"/>`;
  }
  const scale =
    (variant.flame * Math.min(width, height)) / Math.max(box.width, box.height);
  const tx = minX + width / 2 - scale * (box.x + box.width / 2);
  const ty = minY + height / 2 - scale * (box.y + box.height / 2);
  // Solid black: a template image carries its shape in the alpha channel and
  // its colour from the operating system.
  return `<g transform="translate(${String(tx)} ${String(ty)}) scale(${String(scale)})">
            <path d="${flame.d}" fill="#000000"/>
          </g>`;
}
