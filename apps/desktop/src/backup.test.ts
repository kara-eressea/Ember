import { describe, expect, it, vi } from "vitest";
import {
  backupFileName,
  backupSavedMessage,
  BackupError,
  downloadBackup,
  BACKUP_FAILED_TITLE,
  BACKUP_MENU_LABEL,
} from "./backup.js";

const ORIGIN = "http://127.0.0.1:49231";
const TOKEN = "an-access-token";
const ARCHIVE = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]);

/** A `fetch` that answers with whatever this test is about. */
function answering(response: Partial<Response>) {
  const answer = {
    ok: true,
    status: 200,
    text: () => Promise.resolve(""),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    ...response,
  } as Response;
  return vi.fn<typeof globalThis.fetch>(() => Promise.resolve(answer));
}

/** A `fetch` that never gets there — a server that is not listening. */
function unreachable(message: string) {
  return vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error(message)),
  );
}

/** The thrown `BackupError`, for a call that is expected to fail. */
async function failureOf(fetchImpl: typeof globalThis.fetch) {
  return (await downloadBackup({
    origin: ORIGIN,
    accessToken: TOKEN,
    fetch: fetchImpl,
  }).catch((thrown: unknown) => thrown)) as BackupError;
}

describe("downloadBackup", () => {
  it("asks the local server for the archive, with this session's token", async () => {
    const fetchImpl = answering({
      arrayBuffer: () =>
        Promise.resolve(
          ARCHIVE.buffer.slice(
            ARCHIVE.byteOffset,
            ARCHIVE.byteOffset + ARCHIVE.byteLength,
          ),
        ),
    });

    const bytes = await downloadBackup({
      origin: ORIGIN,
      accessToken: TOKEN,
      fetch: fetchImpl,
    });

    expect(bytes).toEqual(ARCHIVE);
    // The endpoint is authenticated on purpose — loopback is not a permission,
    // and this hands over every message the app has ever stored.
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${ORIGIN}/api/backup`);
    expect(init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it("refuses an empty answer rather than writing a plausible-looking file", async () => {
    // A zero-byte file that looks like a backup is worse than no file: it is a
    // backup somebody would rely on.
    await expect(
      downloadBackup({
        origin: ORIGIN,
        accessToken: TOKEN,
        fetch: answering({}),
      }),
    ).rejects.toThrow(BackupError);
  });

  it("carries the server's own words out of a refusal", async () => {
    // The useful half of a 404 here is the server's sentence: it is what says
    // *why* this instance has nothing to package up.
    const fetchImpl = answering({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"error":"…use pg_dump"}'),
    });

    await expect(
      downloadBackup({ origin: ORIGIN, accessToken: TOKEN, fetch: fetchImpl }),
    ).rejects.toThrow(/HTTP 404 — .*pg_dump/s);
  });

  it("says so plainly when the server does not answer at all", async () => {
    const error = await failureOf(unreachable("ECONNREFUSED"));

    expect(error).toBeInstanceOf(BackupError);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.message).toContain("did not answer");
  });

  it("always promises that nothing changed, whatever went wrong", async () => {
    // The one sentence every failure here owes the user: a backup that did not
    // happen must not leave them wondering what it did instead.
    const failures = [
      answering({}),
      answering({ ok: false, status: 500 }),
      unreachable("boom"),
    ];
    for (const fetchImpl of failures) {
      const error = await failureOf(fetchImpl);
      expect(error.message).toContain("nothing on this computer has changed");
      // #543: a human line, a blank line, then the detail a bug report needs.
      expect(error.message.split("\n")[1]).toBe("");
      expect(error.message).toContain("Details: ");
    }
  });
});

describe("the words a user reads", () => {
  it("name the file, not the machinery", () => {
    const jargon =
      /bouncer|pglite|tarball|data directory|dumpDataDir|endpoint/i;
    const { title, body } = backupSavedMessage(
      "EmberChat",
      "/Users/someone/Downloads/EmberChat backup 2026-08-06.tar.gz",
    );
    expect(title).toBe("Backup saved");
    expect(body).toContain("/Users/someone/Downloads/EmberChat backup");
    expect(body).not.toMatch(jargon);
    expect(BACKUP_MENU_LABEL).not.toMatch(jargon);
    expect(BACKUP_FAILED_TITLE).not.toMatch(jargon);
    expect(new BackupError("something").message).not.toMatch(jargon);
  });

  it("suggest a dated file name", () => {
    // Dated rather than timestamped: a backup is a thing you keep and compare
    // by eye, and the platform's own "(1)" handles two on one day.
    expect(
      backupFileName("EmberChat", new Date("2026-08-06T22:41:03.000Z")),
    ).toBe("EmberChat backup 2026-08-06.tar.gz");
  });
});
