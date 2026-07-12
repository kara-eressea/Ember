// F-List avatar URLs (decisions.md §6). Pattern verified against the
// official client's avatarURL() in chat3client site/utils.ts: lowercase the
// name, no further encoding, and refuse names outside the safe charset.

const VALID_NAME = /^[a-zA-Z0-9_\-\s]+$/;

export function avatarUrl(name: string): string | undefined {
  if (!VALID_NAME.test(name)) {
    return undefined;
  }
  return `https://static.f-list.net/images/avatar/${name.toLowerCase()}.png`;
}

export function nameInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}
