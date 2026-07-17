// Link-preview resolver (M8 step 13, decisions.md §14): which URLs the
// client can hotlink as a floating media preview. Two mechanisms — a
// direct-media extension test, and a small per-host rewrite table for
// page URLs whose direct-media form is derivable client-side (data, easy
// to extend). Everything else is a plain link; there is no server proxy
// and no oEmbed — a preview is only ever a plain image/video request from
// the viewer's browser to the host.

export interface PreviewSource {
  /** The URL to hotlink in the preview panel. */
  src: string;
  kind: "image" | "video";
  host: string;
  /** Mono footer path — host + pathname, ellipsised by CSS. */
  path: string;
}

const IMAGE_EXT = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(?:mp4|webm)$/i;

/** Per-host page → direct-media rewrites. Only hosts whose direct form is
 * mechanically derivable belong here — never guess (a wrong rewrite shows
 * a broken preview for a working link). */
const HOST_REWRITES: {
  host: RegExp;
  rewrite: (url: URL) => string | undefined;
}[] = [
  {
    // imgur single-image pages: imgur.com/<id> → i.imgur.com/<id>.jpg
    // (imgur serves the right bytes regardless of the real extension).
    // Albums/galleries have no single derivable image — left alone.
    host: /^(?:www\.)?imgur\.com$/i,
    rewrite: (url) => {
      const match = /^\/([A-Za-z0-9]{5,10})$/.exec(url.pathname);
      return match ? `https://i.imgur.com/${match[1]!}.jpg` : undefined;
    },
  },
];

/** A previewable media source for the URL, or undefined (= plain link). */
export function resolvePreview(href: string): PreviewSource | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const path = `${url.host}${url.pathname}`;
  if (IMAGE_EXT.test(url.pathname)) {
    return { src: href, kind: "image", host: url.host, path };
  }
  if (VIDEO_EXT.test(url.pathname)) {
    return { src: href, kind: "video", host: url.host, path };
  }
  for (const entry of HOST_REWRITES) {
    if (entry.host.test(url.hostname)) {
      const src = entry.rewrite(url);
      if (src !== undefined) {
        return { src, kind: "image", host: url.host, path };
      }
    }
  }
  return undefined;
}

/** LinkChip label: media filename, else the last path segment, else the
 * host — the mono `[host]` suffix rides separately. */
export function chipLabel(href: string): string {
  try {
    const url = new URL(href);
    const segments = url.pathname.split("/").filter((part) => part !== "");
    return segments.at(-1) ?? url.host;
  } catch {
    return href;
  }
}

/** The `[host.com]` chip suffix ("" when the URL doesn't parse). */
export function chipHost(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
}
