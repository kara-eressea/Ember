// Link-preview resolver (M8 step 13, decisions.md §14): which URLs the
// client can hotlink as a floating media preview. Three mechanisms, all
// data-driven — a direct-media extension test; a small set of hosts that
// serve direct media at *any* path (no extension in the URL, #384); and a
// per-host rewrite table for page URLs whose direct-media form is derivable
// client-side. Everything else is a plain link; there is no server proxy
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

/** Image formats some hosts (e.g. Twitter/X's pbs.twimg.com) carry in a
 * `format=` query param instead of the path extension. */
const IMAGE_FORMAT_PARAM = /^(?:avif|gif|jpe?g|jpg|png|webp)$/i;

/** Hosts that serve direct media at any path, so the URL never carries a
 * file extension the extension test can see (#384). A link to one of these
 * is direct media as long as it clears the user's allowlist — the extension
 * requirement is waived. Keep this to hosts that *only* serve media (a page
 * URL here would preview as a broken image), and remember each entry must
 * also be reachable under the CSP host registry / preview allowlist. */
const DIRECT_MEDIA_HOSTS: { host: RegExp; kind: "image" | "video" }[] = [
  // fixvx's direct-media host: d.fixvx.com/<user>/status/<id> 302-redirects
  // to the raw media on twimg — no extension, and the target of the x.com /
  // twitter.com rewrite below. Classified as an image (see that rewrite).
  { host: /^d\.fixvx\.com$/i, kind: "image" },
];

/** Per-host page → direct-media rewrites. Only hosts whose direct form is
 * mechanically derivable belong here — never guess (a wrong rewrite shows
 * a broken preview for a working link). */
const HOST_REWRITES: {
  host: RegExp;
  rewrite: (url: URL) => string | undefined;
}[] = [
  {
    // x.com / twitter.com (and the vxtwitter/fixvx share mirrors) status
    // pages: /<user>/status/<id> → d.fixvx.com/<user>/status/<id>, which
    // serves the tweet's direct media (fixvx is embed-friendly where x.com's
    // own page is not). The displayed link is unchanged — only the embed
    // fetch is rewritten. Tweets carry image *or* video and the path gives no
    // hint; we classify as an image (the common shared case) and let the
    // panel's quiet not-found fallback (#193) cover a video-only tweet rather
    // than probing the media type (no server proxy — decisions.md §14).
    host: /^(?:www\.)?(?:x|twitter|vxtwitter|fixvx|fixupx)\.com$/i,
    rewrite: (url) => {
      const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)/.exec(url.pathname);
      return match
        ? `https://d.fixvx.com/${match[1]!}/status/${match[2]!}`
        : undefined;
    },
  },
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
  {
    // gyazo share pages: gyazo.com/<id> → i.gyazo.com/<id>.png
    // (the direct-media host serves the right bytes for the id).
    // Sub-paths (e.g. /captures, /<id>/thumb) are not single images.
    host: /^(?:www\.)?gyazo\.com$/i,
    rewrite: (url) => {
      const match = /^\/([0-9a-f]{20,40})$/i.exec(url.pathname);
      return match ? `https://i.gyazo.com/${match[1]!}.png` : undefined;
    },
  },
];

/**
 * Is `host` covered by the allowlist? A host matches an entry when it equals
 * it exactly or is a subdomain of it (`i.imgur.com` matches `imgur.com`), so
 * adding an apex host sensibly covers the `i.`/`cdn.`/`www.` variants our
 * rewrites can produce. Both sides are lowercased (hostnames are
 * case-insensitive). (#215)
 */
export function hostAllowed(
  host: string,
  allowHosts: readonly string[],
): boolean {
  const target = host.toLowerCase();
  return allowHosts.some((entry) => {
    const allowed = entry.toLowerCase();
    return target === allowed || target.endsWith(`.${allowed}`);
  });
}

/**
 * A previewable media source for the URL, or undefined (= plain link). When
 * `allowHosts` is given, the *effective* media host (after any page→direct
 * rewrite) must be on the allowlist (#215) — otherwise a resolvable link
 * still renders as a plain link. Omitting `allowHosts` skips the gate (used
 * by unit tests exercising the resolver in isolation).
 */
export function resolvePreview(
  href: string,
  allowHosts?: readonly string[],
): PreviewSource | undefined {
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
  let source: PreviewSource | undefined;
  if (IMAGE_EXT.test(url.pathname)) {
    source = { src: href, kind: "image", host: url.host, path };
  } else if (VIDEO_EXT.test(url.pathname)) {
    source = { src: href, kind: "video", host: url.host, path };
  } else {
    // Some hosts (Twitter/X's pbs.twimg.com) declare the image type in a
    // `format=` query param rather than the path extension — the URL still
    // hotlinks directly, so keep the full query (name=, etc.) on the src.
    const format = url.searchParams.get("format");
    const direct = DIRECT_MEDIA_HOSTS.find((entry) =>
      entry.host.test(url.hostname),
    );
    if (format !== null && IMAGE_FORMAT_PARAM.test(format)) {
      source = { src: href, kind: "image", host: url.host, path };
    } else if (direct !== undefined) {
      // A host that serves direct media at any path — hotlink the URL as-is,
      // no extension required (#384).
      source = { src: href, kind: direct.kind, host: url.host, path };
    } else {
      for (const entry of HOST_REWRITES) {
        if (entry.host.test(url.hostname)) {
          const src = entry.rewrite(url);
          if (src !== undefined) {
            source = { src, kind: "image", host: url.host, path };
            break;
          }
        }
      }
    }
  }
  if (source === undefined) {
    return undefined;
  }
  if (allowHosts !== undefined) {
    // Gate on the host actually hotlinked — the rewrite target, not the page
    // host (issue guidance: match the effective host after any rewrite).
    let effectiveHost = source.host;
    try {
      effectiveHost = new URL(source.src).host;
    } catch {
      // source.src is always a URL we built; the fallback is defensive only.
    }
    if (!hostAllowed(effectiveHost, allowHosts)) {
      return undefined;
    }
  }
  return source;
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
