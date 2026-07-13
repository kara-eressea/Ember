// Human-readable app URLs (M3, Discord-inspired):
//   /app/<Character>/c/<channelKey>   /app/<Character>/dm/<partner>
// F-List character names are globally unique, so names are the natural keys
// (F-List's own /c/<name> profile URLs are precedent for encoded spaces).
// Resolution is case-insensitive (F-Chat semantics); the shell restores
// canonical casing with a replace-navigation. `@me` aliases the last-active
// identity so bookmarks can stay identity-agnostic, and the old UUID routes
// keep working as redirects.

import type { IdentitySession, IdentitySummary } from "../stores/sessions.js";

const LAST_IDENTITY_KEY = "emberchat.lastIdentityId";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function identityPath(name: string): string {
  return `/app/${encodeURIComponent(name)}`;
}

/** Path suffix under the identity segment: "c/Frontpage", "dm/Nyx%20Firemane". */
export function channelSuffix(channelKey: string): string {
  return `c/${encodeURIComponent(channelKey)}`;
}

export function dmSuffix(partner: string): string {
  return `dm/${encodeURIComponent(partner)}`;
}

export function channelPath(identityName: string, channelKey: string): string {
  return `${identityPath(identityName)}/${channelSuffix(channelKey)}`;
}

export function dmPath(identityName: string, partner: string): string {
  return `${identityPath(identityName)}/${dmSuffix(partner)}`;
}

/** localStorage may be unavailable (private mode, storage quotas). */
export function rememberLastIdentity(id: string): void {
  try {
    localStorage.setItem(LAST_IDENTITY_KEY, id);
  } catch {
    // Best effort — @me just falls back to the first identity.
  }
}

function lastIdentityId(): string | undefined {
  try {
    return localStorage.getItem(LAST_IDENTITY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The identity a URL segment names: `@me` = last-active (first identity as
 * the fallback), a UUID = the old route shape, anything else = a character
 * name matched case-insensitively.
 */
export function resolveIdentity(
  identities: IdentitySummary[],
  slug: string,
): IdentitySummary | undefined {
  if (slug === "@me") {
    const last = lastIdentityId();
    return identities.find((i) => i.id === last) ?? identities[0];
  }
  if (isUuid(slug)) {
    return identities.find((i) => i.id === slug);
  }
  const lower = slug.toLowerCase();
  return identities.find((i) => i.name.toLowerCase() === lower);
}

export type ConvRef =
  | { kind: "c"; target: string }
  | { kind: "dm"; target: string }
  | { kind: "legacy"; convId: string };

export interface ResolvedConv {
  convId: string;
  /** Canonical (encoded) path suffix — the URL the conversation should live at. */
  suffix: string;
}

/**
 * The conversation a URL names, against the identity's synced slice.
 * Channels resolve by key (public names, ADH- ids for private rooms), DMs by
 * partner — both case-insensitive; legacy refs are the old UUID conv routes.
 * Undefined when the slice holds no such conversation (not joined / never
 * opened / deleted).
 */
export function resolveConv(
  session: IdentitySession,
  ref: ConvRef,
): ResolvedConv | undefined {
  if (ref.kind === "legacy") {
    const key = session.channelByConvId[ref.convId];
    const channel = key === undefined ? undefined : session.channels[key];
    if (channel && channel.convId !== "") {
      return { convId: channel.convId, suffix: channelSuffix(channel.key) };
    }
    const dm = session.dms[ref.convId];
    return dm ? { convId: dm.convId, suffix: dmSuffix(dm.partner) } : undefined;
  }
  const lower = ref.target.toLowerCase();
  if (ref.kind === "c") {
    const channel = Object.values(session.channels).find(
      (ch) => ch.key.toLowerCase() === lower,
    );
    return channel && channel.convId !== ""
      ? { convId: channel.convId, suffix: channelSuffix(channel.key) }
      : undefined;
  }
  const dm = Object.values(session.dms).find(
    (d) => d.partner.toLowerCase() === lower,
  );
  return dm ? { convId: dm.convId, suffix: dmSuffix(dm.partner) } : undefined;
}
