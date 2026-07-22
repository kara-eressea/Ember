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
// shipped defaults "just work" and the two lists can't drift. Note the
// remaining limitation: a user who adds a *custom* host to their preview
// allowlist is still gated by this server-set policy — self-hosters extend it
// at deploy time; the built-in defaults (the reported failure) are covered.

import { DEFAULT_IMAGE_PREVIEW_HOSTS } from "@emberchat/protocol";

/** `https://<host>` CSP source for every shipped preview host — the set the
 * browser must be allowed to load inline avatars, eicons and link previews
 * from. */
export function mediaHostSources(): string[] {
  return DEFAULT_IMAGE_PREVIEW_HOSTS.map((host) => `https://${host}`);
}

/** The full CSP directive map for the hosted SPA. */
export function contentSecurityDirectives(): Record<string, string[]> {
  const mediaHosts = mediaHostSources();
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    // React style attributes need inline styles allowed.
    "style-src": ["'self'", "'unsafe-inline'"],
    // Avatars/eicons hotlink from F-List's static host; link previews hotlink
    // the default preview hosts (Discord CDN, twimg, imgur, gyazo, xariah).
    "img-src": ["'self'", "data:", ...mediaHosts],
    // [url] video previews (mp4/webm) load via <video src> — governed by
    // media-src, which falls back to default-src ('self') and would otherwise
    // block every off-host clip.
    "media-src": ["'self'", ...mediaHosts],
    "connect-src": ["'self'"],
    "font-src": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
}
