// Content-Security-Policy directives for the SPA the server can host (#335).
//
// The browser enforces `img-src`/`media-src` *before* any subresource request
// leaves the page — so a host missing here is dead no matter how correctly the
// client resolves its URL. The link-preview allowlist (a user pref) decides
// *which* URLs the client hotlinks; this policy must additionally permit the
// browser to fetch them. Before #335 only `static.f-list.net` was allowed, so
// every Discord CDN / twimg / imgur / gyazo preview was blocked while F-List
// avatars (the one whitelisted host) loaded fine — matching the bug report
// exactly.
//
// The permitted media hosts are derived from DEFAULT_IMAGE_PREVIEW_HOSTS so the
// shipped defaults "just work" and the two lists can't drift. On an admin-only
// instance every user is trusted, so a host a user *adds* to their preview
// allowlist should be honoured too (#342): the server folds the union of every
// user's saved `imagePreviewHosts` into `img-src`/`media-src` via the optional
// `extraMediaSource` provider below. Entries are sanitized to bare hostnames
// before they can reach the header — see `sanitizePreviewHost` — so a malformed
// pref can never inject a CSP directive.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_IMAGE_PREVIEW_HOSTS,
  IMAGE_PREVIEW_HOST,
} from "@emberchat/protocol";
import type { SessionLogger } from "../modules/session-engine/fchat-session.js";

/** A helmet CSP directive entry: a literal source, or a function evaluated per
 * response (helmet 8 supports this) so we can widen a directive from live
 * in-memory state without rebuilding the header. */
export type CspDirectiveEntry =
  string | ((req: IncomingMessage, res: ServerResponse) => string);

/** `https://<host>` CSP source for every shipped preview host — the set the
 * browser must be allowed to load inline avatars, eicons and link previews
 * from. */
export function mediaHostSources(): string[] {
  return DEFAULT_IMAGE_PREVIEW_HOSTS.map((host) => `https://${host}`);
}

/** The shipped preview hosts, lowercased, for de-duping user-added entries out
 * of the widened directive (they are already covered by the defaults). */
const DEFAULT_PREVIEW_HOST_SET = new Set<string>(
  DEFAULT_IMAGE_PREVIEW_HOSTS.map((host) => host.toLowerCase()),
);

/**
 * Reduce an untrusted preference entry to a bare, header-safe hostname, or
 * `undefined` if it is not one. Only the `IMAGE_PREVIEW_HOST` grammar (the same
 * one the pref schema enforces) is accepted — dot-separated DNS labels, no
 * scheme, port, path, wildcard, whitespace, comma or semicolon — so nothing a
 * malformed or hostile pref could contain can widen or inject a CSP directive.
 * Non-strings and empty values are rejected. The result is lowercased.
 */
export function sanitizePreviewHost(entry: unknown): string | undefined {
  if (typeof entry !== "string") {
    return undefined;
  }
  const host = entry.trim().toLowerCase();
  if (host.length === 0 || !IMAGE_PREVIEW_HOST.test(host)) {
    return undefined;
  }
  return host;
}

/**
 * Build the sorted, de-duplicated union of every user's `imagePreviewHosts`
 * from their (untrusted) stored prefs documents. Each entry is passed through
 * `sanitizePreviewHost`; a non-empty entry that fails is skipped and logged so
 * a self-hoster can see a bad pref was dropped rather than silently widening or
 * corrupting the header.
 */
export function unionPreviewHosts(
  prefsDocs: Iterable<unknown>,
  log?: SessionLogger,
): string[] {
  const hosts = new Set<string>();
  for (const doc of prefsDocs) {
    if (typeof doc !== "object" || doc === null) {
      continue;
    }
    const list = (doc as Record<string, unknown>).imagePreviewHosts;
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      const clean = sanitizePreviewHost(entry);
      if (clean !== undefined) {
        hosts.add(clean);
      } else if (entry !== undefined && entry !== null && entry !== "") {
        log?.warn(
          { entry: typeof entry === "string" ? entry : typeof entry },
          "csp: dropped invalid image-preview host from a user preference",
        );
      }
    }
  }
  return [...hosts].sort();
}

/** The space-joined `https://<host>` sources for user-added hosts that are not
 * already among the shipped defaults — the value appended to `img-src`/
 * `media-src`. Empty string when there is nothing extra to permit. */
export function extraMediaSourceString(unionHosts: readonly string[]): string {
  return unionHosts
    .filter((host) => !DEFAULT_PREVIEW_HOST_SET.has(host))
    .map((host) => `https://${host}`)
    .join(" ");
}

/**
 * The full CSP directive map for the hosted SPA.
 *
 * `extraMediaSource`, when supplied, is a helmet directive function appended to
 * `img-src` and `media-src` only — evaluated per response so the union of
 * user-added preview hosts (#342) can change (a pref update) without a restart.
 * Every other directive is unchanged.
 */
export function contentSecurityDirectives(
  extraMediaSource?: (req: IncomingMessage, res: ServerResponse) => string,
): Record<string, CspDirectiveEntry[]> {
  const mediaHosts = mediaHostSources();
  const extra: CspDirectiveEntry[] =
    extraMediaSource === undefined ? [] : [extraMediaSource];
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    // React style attributes need inline styles allowed.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Avatars/eicons hotlink from F-List's static host; link previews hotlink
    // the default preview hosts (Discord CDN, twimg, imgur, gyazo, xariah) plus
    // any host a user added to their allowlist (#342).
    "img-src": ["'self'", "data:", ...mediaHosts, ...extra],
    // [url] video previews (mp4/webm) load via <video src> — governed by
    // media-src, which falls back to default-src ('self') and would otherwise
    // block every off-host clip.
    "media-src": ["'self'", ...mediaHosts, ...extra],
    "connect-src": ["'self'"],
    "font-src": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
}
