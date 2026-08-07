/**
 * "Save a backup…" — one file, taken while the app keeps running (#548).
 *
 * ── WHY IT GOES OVER HTTP ────────────────────────────────────────────────────
 * The database is pglite, and pglite is a whole Postgres inside the *server
 * child*, not inside this process. The primitive that makes a live backup
 * possible — `dumpDataDir()`, 551 ms and a 39 MB directory into a 4.85 MB
 * tarball, restoring clean (MX2 spike §4) — is a method on an instance only
 * that child holds. This process cannot call it, and must not go around it:
 * pglite takes no data-directory lock, so a second process opening those files
 * is corruption rather than a second reader (spec invariant 5).
 *
 * So the shell asks the server for the bytes, the way it asks it for everything
 * else: over the loopback socket, with a session of its own. The server side is
 * `apps/server/src/modules/meta/backup.ts`. The alternatives were considered
 * and are worse — an IPC channel into the child does not exist on Windows,
 * where the child is a spawned process rather than a `utilityProcess`
 * (`embedded-server.ts`), and a cold file copy from here is exactly the
 * quit-first ritual this replaces.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
 * A restore. Writing a backup out is a read; reading one back in replaces the
 * history it lands on, and getting that wrong costs the thing the backup
 * existed to protect. It stays a documented manual step (docs/desktop.md).
 *
 * Electron-free, like the rest of this package's decisions: `main.ts` owns the
 * dialogs and the file write, and hands the network in.
 */

/** The menu item. Plain language (#543): no "database", no "data directory". */
export const BACKUP_MENU_LABEL = "Save a backup…";

/** Enough for a large history over loopback; the dump itself is sub-second. */
const BACKUP_TIMEOUT_MS = 120_000;

/**
 * What the save dialog suggests. Dated rather than timestamped: a backup is a
 * thing you keep and compare by eye, and the platform's own "(1)" handles two
 * on one day.
 */
export function backupFileName(productName: string, now: Date): string {
  return `${productName} backup ${now.toISOString().slice(0, 10)}.tar.gz`;
}

/**
 * The backup did not happen — and, importantly, nothing else did either. The
 * message is the whole thing a user reads: a human first line, then the
 * `Details:` line a bug report needs (#543).
 */
export class BackupError extends Error {
  constructor(
    detail: string,
    options?: ErrorOptions & {
      /**
       * The human first line, when the default would be a lie. Everything up
       * to the point where bytes hit the disk really has changed nothing; a
       * failed *write* is the one case that cannot promise that, so it says
       * something else (see `main.ts`).
       */
      readonly opening?: string;
    },
  ) {
    super(
      [
        options?.opening ??
          "Nothing was saved, and nothing on this computer has changed.",
        "",
        `Details: ${detail}`,
      ].join("\n"),
      options,
    );
    this.name = "BackupError";
  }
}

export interface DownloadBackupOptions {
  /** The embedded server's loopback origin. */
  readonly origin: string;
  /** A live access token — see `desktop-login.ts` for where it comes from. */
  readonly accessToken: string;
  /** Injectable for tests; the real `fetch` otherwise. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** The archive's bytes, or a `BackupError` saying why there are none. */
export async function downloadBackup(
  options: DownloadBackupOptions,
): Promise<Uint8Array> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(`${options.origin}/api/backup`, {
      headers: { authorization: `Bearer ${options.accessToken}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? BACKUP_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new BackupError(
      "the local server did not answer the request for a backup.",
      { cause },
    );
  }
  if (!response.ok) {
    // The server's own words, capped: they are the useful half of a 404 (a
    // build whose database is not the embedded one) or a 500.
    const said = (await response.text().catch(() => "")).slice(0, 500).trim();
    throw new BackupError(
      `the local server answered HTTP ${String(response.status)}${said === "" ? "" : ` — ${said}`}.`,
    );
  }
  let bytes: Uint8Array;
  try {
    // A body that dies mid-transfer throws here, not above — the headers were
    // fine. Same answer either way: no bytes, so no file.
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    throw new BackupError("the download stopped before it finished.", {
      cause,
    });
  }
  if (bytes.byteLength === 0) {
    // Refused rather than written. A zero-byte file that looks like a backup
    // is worse than no file at all: it is a backup you would rely on.
    throw new BackupError("the local server sent an empty file.");
  }
  return bytes;
}

/**
 * What the app says once the file is on disk.
 *
 * Two things it must get across and one it must not oversell: where the file
 * is, that it belongs somewhere other than this disk, and — the honest
 * limit — that this is the history, not the whole install. `secrets.json` is
 * encrypted to this computer's keychain and cannot be in here, which is why
 * docs/desktop.md keeps the whole-folder copy as the other half of the story.
 */
export function backupSavedMessage(
  productName: string,
  filePath: string,
): { readonly title: string; readonly body: string } {
  return {
    title: "Backup saved",
    body: [
      `Your conversations and settings are in this one file:`,
      "",
      filePath,
      "",
      `Keep a copy somewhere other than this computer. ${productName} kept running the whole time and nothing here has changed.`,
    ].join("\n"),
  };
}

/** The headline over a `BackupError`'s own text. */
export const BACKUP_FAILED_TITLE = "The backup couldn't be saved";
