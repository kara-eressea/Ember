// Favicon unread badge (#390): overlay the tab icon with a counter whenever
// the user has unread direct messages or highlight mentions waiting on any
// identity, so a backgrounded tab still signals "someone's talking to you".
// The count mirrors the in-app rail badges (see rail-data.ts) — DM unreads
// plus mentions — and drops back to the plain icon at zero.

import type { IdentitySession, IdentitySummary } from "../stores/sessions.js";

/**
 * Attention total across every identity: unread DMs plus highlight mentions.
 * A synced slice has live per-conversation counters (DM unreads on `dms`,
 * mention counters on `channels`); an unsynced identity only knows the
 * ready-frame `mentions` total, which is all we can attribute to it until it
 * subscribes. Channel unreads that never named the user are deliberately
 * excluded — the badge is for messages aimed at you, matching the title flash.
 */
export function unreadBadgeCount(
  identities: IdentitySummary[] | undefined,
  sessions: Record<string, IdentitySession | undefined>,
): number {
  if (!identities) {
    return 0;
  }
  let total = 0;
  for (const identity of identities) {
    const slice = sessions[identity.id];
    if (!slice?.synced) {
      total += identity.mentions;
      continue;
    }
    for (const channel of Object.values(slice.channels)) {
      total += channel.mentions;
    }
    for (const dm of Object.values(slice.dms)) {
      total += dm.unread;
    }
  }
  return total;
}

const BASE_ICON_HREF = "/favicon.svg";
const CANVAS_SIZE = 32;

let currentCount: number | null = null;
let baseImage: HTMLImageElement | undefined;
let canvas: HTMLCanvasElement | undefined;

function iconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  return link;
}

function restorePlainIcon(): void {
  const link = iconLink();
  link.type = "image/svg+xml";
  link.href = BASE_ICON_HREF;
}

function drawBadge(count: number): void {
  if (!baseImage?.complete || baseImage.naturalWidth === 0) {
    return;
  }
  canvas ??= document.createElement("canvas");
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  ctx.drawImage(baseImage, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // A filled disc in the corner. Small icons render the count illegibly, so
  // below a threshold we show just the dot — presence, not a precise number.
  const label = count > 99 ? "99+" : String(count);
  const radius = CANVAS_SIZE * (label.length > 2 ? 0.34 : 0.3);
  const cx = CANVAS_SIZE - radius;
  const cy = radius;

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = "#e5484d";
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.font = `600 ${String(Math.round(radius * 1.3))}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, cx, cy + radius * 0.05);

  const link = iconLink();
  link.type = "image/png";
  link.href = canvas.toDataURL("image/png");
}

/**
 * Point the dynamic favicon at a badged render of `count`, or restore the
 * plain icon at zero. Cheap by construction: a no-op when the count is
 * unchanged, and the base SVG is rasterised once then reused.
 */
export function applyFaviconBadge(count: number): void {
  if (count === currentCount) {
    return;
  }
  currentCount = count;

  if (count <= 0) {
    restorePlainIcon();
    return;
  }

  if (!baseImage) {
    baseImage = new Image();
    baseImage.src = BASE_ICON_HREF;
    baseImage.onload = () => {
      // The count may have changed while the image loaded; render the latest.
      if (currentCount && currentCount > 0) {
        drawBadge(currentCount);
      }
    };
  }
  drawBadge(count);
}
