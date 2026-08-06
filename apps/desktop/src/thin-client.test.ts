import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { authSeedMessage, createSeedHolder } from "./auth-seed.js";
import {
  REMOTE_RETRY_CHANNEL,
  REMOTE_SWITCH_MODE_CHANNEL,
} from "./error-ipc.js";
import { planThinClientLaunch } from "./thin-client.js";

const SERVER = "https://chat.example.com";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

describe("planThinClientLaunch", () => {
  it("shows the window when the server answers", async () => {
    const probe = vi.fn().mockResolvedValue({ ok: true, url: SERVER });
    expect(await planThinClientLaunch(SERVER, probe)).toEqual({
      kind: "window",
      serverUrl: SERVER,
    });
    // Every launch asks, not just the one where the address was typed: an
    // address that answered last week is not evidence about today.
    expect(probe).toHaveBeenCalledExactlyOnceWith(SERVER);
  });

  it("shows the error page instead of a window when it does not", async () => {
    const launch = await planThinClientLaunch(SERVER, () =>
      Promise.resolve({
        ok: false,
        kind: "unreachable",
        message: `Could not reach ${SERVER}.`,
      }),
    );
    expect(launch.kind).toBe("error");
    if (launch.kind !== "error") {
      return;
    }
    // The probe's own sentence, with a headline over it — the window is never
    // opened at all, so Chromium never gets to render its own page.
    expect(launch.failure.detail).toContain(SERVER);
    expect(launch.failure.headline).toBe("Can't reach your server");
  });

  it("passes a certificate refusal through as one", async () => {
    const launch = await planThinClientLaunch(SERVER, () =>
      Promise.resolve({
        ok: false,
        kind: "certificate",
        message: `${SERVER} presented a security certificate this computer will not accept (ERR_CERT_DATE_INVALID).`,
      }),
    );
    expect(
      launch.kind === "error" && launch.failure.headline.toLowerCase(),
    ).toContain("certificate");
  });
});

describe("the auth seed in thin-client mode", () => {
  it("is never armed, and answers null", () => {
    const holder = createSeedHolder("thin-client");
    expect(holder.take()).toBeNull();
    // Not "does not happen to be armed" — cannot be. The window shows a server
    // this process never logged into; a seed here would be a session token
    // written into somebody else's origin's storage.
    expect(() => {
      holder.arm(
        authSeedMessage({
          user: { id: "u", email: "e", username: "u" },
          refreshToken: "t",
        }),
      );
    }).toThrow(/thin-client/);
    expect(holder.take()).toBeNull();
  });

  it("is inert on the run that only asks the question, too", () => {
    const holder = createSeedHolder("choose");
    expect(holder.take()).toBeNull();
    expect(() => {
      holder.arm({ key: "eb.auth", value: "{}" });
    }).toThrow();
  });

  it("still hands a local boot its one seed", () => {
    const holder = createSeedHolder("local");
    expect(holder.take()).toBeNull(); // before the login finishes
    const message = { key: "eb.auth", value: "{}" };
    holder.arm(message);
    expect(holder.take()).toEqual(message);
    expect(holder.take()).toBeNull(); // once, and only once (#301)
  });
});

describe("the error page's preload", () => {
  const source = read("error-preload.cts");

  it("calls on the same two channels main answers on", () => {
    // A sandboxed CommonJS preload cannot import the ES module that declares
    // these, so the two names are spelled twice. This is the seam.
    expect(source).toContain(`"${REMOTE_RETRY_CHANNEL}"`);
    expect(source).toContain(`"${REMOTE_SWITCH_MODE_CHANNEL}"`);
  });

  it("exposes exactly the two calls the page needs", () => {
    const bridge =
      /exposeInMainWorld\([^)]*\{([\s\S]*?)\}\);/.exec(source)?.[1] ?? "";
    const exposed = [...bridge.matchAll(/^\s+(\w+):/gm)].map(
      (match) => match[1],
    );
    expect(exposed).toEqual(["retry", "switchMode"]);
  });

  it("is not the auth-seed preload, and does not touch storage", () => {
    // The app window's preload writes localStorage and exposes nothing; this
    // one exposes two calls and touches no storage. Neither may become the
    // other (spec invariant 2, #301 as-built 2).
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sendSync");
  });
});

describe("certificate errors are fatal", () => {
  it("has no bypass anywhere in the shell", () => {
    // Electron's default is to refuse a certificate it cannot verify. The two
    // ways to undo that are a `certificate-error` handler that calls
    // `event.preventDefault()` and `session.setCertificateVerifyProc`. Neither
    // may exist here — an https target with a bad certificate must fail with an
    // explanation, never with a button (spec §5).
    for (const file of [
      "main.ts",
      "window.ts",
      "error-window.ts",
      "chooser-window.ts",
      "embedded-server.ts",
      "server-fork.ts",
    ]) {
      const source = read(file);
      // The call, not the word: both are named in the comments that explain
      // why they are absent, and a rule that forbade saying so would be a rule
      // against documenting the decision.
      expect(source).not.toContain("setCertificateVerifyProc(");
      expect(source).not.toContain('on("certificate-error"');
      expect(source).not.toContain("ignore-certificate-errors");
    }
  });
});
