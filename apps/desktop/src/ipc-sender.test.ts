import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { senderAllowed, type IpcCaller } from "./ipc-sender.js";

/** The shell's own page, as `loadFile` will have spelled its URL. */
const CHOOSER_PAGE = "/opt/EmberChat/chooser/index.html";
const CHOOSER_URL = pathToFileURL(CHOOSER_PAGE).href;
const CHOOSER: IpcCaller = { kind: "page", page: CHOOSER_PAGE };

const ERROR_PAGE = "/opt/EmberChat/error/index.html";
const APP_ORIGIN: IpcCaller = {
  kind: "origin",
  origin: "https://chat.example.com",
};

const top = (url: string) => ({ url, topFrame: true });

describe("senderAllowed — the shell's own pages", () => {
  it("answers the page it was loaded from", () => {
    expect(senderAllowed(top(CHOOSER_URL), CHOOSER)).toBe(true);
  });

  it("answers it with the query parameters it was loaded with", () => {
    // Both pages take their variable strings that way (§4/§5), so the URL a
    // frame reports is never the bare path.
    expect(
      senderAllowed(
        top(
          `${CHOOSER_URL}?product=EmberChat&url=https%3A%2F%2Fchat.example.com`,
        ),
        CHOOSER,
      ),
    ).toBe(true);
  });

  it("refuses the shell's other page", () => {
    // The two windows have two vocabularies; neither may speak the other's.
    expect(senderAllowed(top(pathToFileURL(ERROR_PAGE).href), CHOOSER)).toBe(
      false,
    );
  });

  it("refuses another file on this disk", () => {
    expect(senderAllowed(top("file:///tmp/evil/index.html"), CHOOSER)).toBe(
      false,
    );
  });

  it("refuses a remote page claiming to be it", () => {
    expect(
      senderAllowed(
        top("https://chat.example.com/chooser/index.html"),
        CHOOSER,
      ),
    ).toBe(false);
  });

  it("refuses a subframe of the right page", () => {
    // A page can embed any URL it likes; a subframe's own URL says nothing
    // about the document that embedded it.
    expect(senderAllowed({ url: CHOOSER_URL, topFrame: false }, CHOOSER)).toBe(
      false,
    );
  });

  it("matches case-insensitively only where the filesystem does", () => {
    // Windows (MX4 packages it): `C:\Users\…` and `c:\users\…` are one file,
    // and Chromium's spelling of a drive letter need not match ours.
    const shouted = pathToFileURL(CHOOSER_PAGE.toUpperCase()).href;
    expect(
      senderAllowed(top(shouted), CHOOSER, { caseInsensitivePaths: true }),
    ).toBe(true);
    // Everywhere else two spellings are two files, and only one of them is the
    // page this app shipped.
    expect(
      senderAllowed(top(shouted), CHOOSER, { caseInsensitivePaths: false }),
    ).toBe(false);
  });
});

describe("senderAllowed — the app window's origin", () => {
  it("answers the origin this process chose to show", () => {
    expect(senderAllowed(top("https://chat.example.com/"), APP_ORIGIN)).toBe(
      true,
    );
    // Any path on that origin: the web app is a single-page app with routes.
    expect(
      senderAllowed(top("https://chat.example.com/channel/adh-1"), APP_ORIGIN),
    ).toBe(true);
  });

  it("refuses a different origin", () => {
    expect(senderAllowed(top("https://evil.example.com/"), APP_ORIGIN)).toBe(
      false,
    );
    // A subdomain is a different origin, and so is a sibling path host.
    expect(
      senderAllowed(top("https://chat.example.com.evil.test/"), APP_ORIGIN),
    ).toBe(false);
  });

  it("refuses the same host on another scheme or port", () => {
    expect(senderAllowed(top("http://chat.example.com/"), APP_ORIGIN)).toBe(
      false,
    );
    expect(
      senderAllowed(top("https://chat.example.com:8443/"), APP_ORIGIN),
    ).toBe(false);
  });

  it("refuses a subframe on the right origin", () => {
    expect(
      senderAllowed(
        { url: "https://chat.example.com/", topFrame: false },
        APP_ORIGIN,
      ),
    ).toBe(false);
  });

  it("refuses schemes that are not the web", () => {
    for (const url of [
      "file:///opt/EmberChat/error/index.html",
      "data:text/html,<script>1</script>",
      "about:blank",
      "",
    ]) {
      expect(senderAllowed(top(url), APP_ORIGIN)).toBe(false);
    }
  });

  it("answers a loopback origin exactly (local mode)", () => {
    const loopback: IpcCaller = {
      kind: "origin",
      origin: "http://127.0.0.1:54321",
    };
    expect(senderAllowed(top("http://127.0.0.1:54321/"), loopback)).toBe(true);
    // Same machine, different port: a different server entirely.
    expect(senderAllowed(top("http://127.0.0.1:54322/"), loopback)).toBe(false);
    // `localhost` and `127.0.0.1` are different origins to a browser, and the
    // shell always loads the numeric one.
    expect(senderAllowed(top("http://localhost:54321/"), loopback)).toBe(false);
  });
});

describe("senderAllowed — nothing to be", () => {
  it("refuses when the sender is gone", () => {
    expect(senderAllowed(undefined, CHOOSER)).toBe(false);
  });

  it("refuses when the channel has no legitimate caller yet", () => {
    // The window that owns this channel has not been opened, so nobody is it.
    expect(senderAllowed(top(CHOOSER_URL), undefined)).toBe(false);
    expect(senderAllowed(undefined, undefined)).toBe(false);
  });
});
