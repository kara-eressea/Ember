// Recognize F-List character-page URLs (#214): links to
// f-list.net/c/<name> that appear in chat, profiles, or status text open
// the in-app profile viewer instead of a browser tab. The name is
// URL-decoded here (F-List names allow spaces, sent as %20 on the wire).

/**
 * If `href` points at an F-List character page
 * (`https://www.f-list.net/c/<name>` and equivalents — with or without
 * `www.`, http/https, an optional trailing slash), return the decoded
 * character name. Otherwise return undefined so the link keeps normal
 * behavior.
 */
export function parseCharacterUrl(href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "f-list.net" && host !== "www.f-list.net") {
    return undefined;
  }
  const match = /^\/c\/([^/]+)\/?$/.exec(url.pathname);
  if (match?.[1] === undefined) {
    return undefined;
  }
  let name: string;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    // Malformed percent-encoding — not a name we can open.
    return undefined;
  }
  name = name.trim();
  return name === "" ? undefined : name;
}
