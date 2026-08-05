import * as webpush from "web-push";
import { describe, expect, it } from "vitest";
import { loadConfig, trustProxyValue } from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://emberchat:emberchat@localhost:5432/emberchat",
  AUTH_SECRET: "unit-test-secret-0123456789abcdef-xyz",
};

// Generated rather than hardcoded: a "VAPID keypair" literal in a public repo
// invites somebody to paste it into a real .env (secrets hygiene,
// decisions.md §7), and the library's own generator is the authority on the
// shape the config guard has to accept.
const keys = webpush.generateVAPIDKeys();
const VAPID_ENV = {
  PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
  PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
  PUSH_VAPID_SUBJECT: "mailto:admin@example.test",
};

describe("loadConfig", () => {
  it("parses a minimal env and applies defaults", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.FCHAT_URL).toBe("wss://chat.f-list.net/chat2");
    expect(config.PORT).toBe(3000);
    expect(config.TRUST_PROXY).toBeUndefined();
    // An env that never heard of DB_DRIVER is a node-postgres env (#298).
    expect(config.DB_DRIVER).toBe("node-postgres");
  });

  it("requires the setting its storage driver actually needs (#298)", () => {
    const noUrl = { AUTH_SECRET: BASE_ENV.AUTH_SECRET };
    expect(() => loadConfig(noUrl)).toThrow(/DATABASE_URL must be set/);
    expect(() => loadConfig({ ...noUrl, DB_DRIVER: "pglite" })).toThrow(
      /PGLITE_DATA_DIR must be set/,
    );
    // pglite with a data dir needs no DATABASE_URL at all.
    expect(
      loadConfig({ ...noUrl, DB_DRIVER: "pglite", PGLITE_DATA_DIR: "/tmp/db" })
        .DATABASE_URL,
    ).toBeUndefined();
    expect(() => loadConfig({ ...BASE_ENV, DB_DRIVER: "sqlite" })).toThrow();
  });

  it("refuses the .env.example placeholder AUTH_SECRET", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        AUTH_SECRET: "dev-only-secret-change-me-0000000000",
      }),
    ).toThrow(/placeholder/);
  });

  it("treats an empty CREDENTIALS_KEY as unset, refuses a malformed one", () => {
    expect(
      loadConfig({ ...BASE_ENV, CREDENTIALS_KEY: "" }).CREDENTIALS_KEY,
    ).toBeUndefined();
    expect(() =>
      loadConfig({ ...BASE_ENV, CREDENTIALS_KEY: "too-short" }),
    ).toThrow(/32 bytes/);
  });

  it("names the decoded length when CREDENTIALS_KEY is the wrong size", () => {
    // 64 hex chars are all valid base64url, so a hex "32-byte" key decodes
    // to 48 bytes — the realistic trap the message must call out.
    const hexKey = "ab".repeat(32);
    expect(() => loadConfig({ ...BASE_ENV, CREDENTIALS_KEY: hexKey })).toThrow(
      /64-character value decoding to 48 bytes/,
    );
  });

  it("allows a sub-policy reconnect floor only against a local sim", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, FCHAT_RECONNECT_FLOOR_MS: "300" }),
    ).toThrow(/only allowed against a local fchat-sim/);
    expect(
      loadConfig({
        ...BASE_ENV,
        FCHAT_URL: "ws://127.0.0.1:9090/chat2",
        FCHAT_RECONNECT_FLOOR_MS: "300",
      }).FCHAT_RECONNECT_FLOOR_MS,
    ).toBe(300);
    // The policy floor itself is always fine, sim or not.
    expect(
      loadConfig({ ...BASE_ENV, FCHAT_RECONNECT_FLOOR_MS: "10000" })
        .FCHAT_RECONNECT_FLOOR_MS,
    ).toBe(10_000);
  });

  it("does not mistake a lookalike host for f-list.net", () => {
    // endsWith("f-list.net") would match "notf-list.net" and refuse to boot.
    expect(
      loadConfig({
        ...BASE_ENV,
        FCHAT_URL: "wss://chat.notf-list.net/chat2",
        FCHAT_RECONNECT_FLOOR_MS: "300",
      }).FCHAT_RECONNECT_FLOOR_MS,
    ).toBe(300);
  });

  it("refuses a non-websocket FCHAT_URL", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, FCHAT_URL: "https://chat.f-list.net/chat2" }),
    ).toThrow();
    expect(
      loadConfig({ ...BASE_ENV, FCHAT_URL: "ws://127.0.0.1:9090/chat2" })
        .FCHAT_URL,
    ).toBe("ws://127.0.0.1:9090/chat2");
  });

  it("leaves web push unconfigured when no PUSH_VAPID_* var is set", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.PUSH_VAPID_PUBLIC_KEY).toBeUndefined();
    expect(config.PUSH_VAPID_PRIVATE_KEY).toBeUndefined();
    expect(config.PUSH_VAPID_SUBJECT).toBeUndefined();
  });

  it("accepts a complete VAPID triple, empty strings reading as unset", () => {
    expect(
      loadConfig({ ...BASE_ENV, ...VAPID_ENV }).PUSH_VAPID_PUBLIC_KEY,
    ).toBe(VAPID_ENV.PUSH_VAPID_PUBLIC_KEY);
    // docker-compose passes `${VAR:-}`: all three empty is "push disabled",
    // not "three half-set vars".
    expect(
      loadConfig({
        ...BASE_ENV,
        PUSH_VAPID_PUBLIC_KEY: "",
        PUSH_VAPID_PRIVATE_KEY: "",
        PUSH_VAPID_SUBJECT: "",
      }).PUSH_VAPID_SUBJECT,
    ).toBeUndefined();
  });

  it("refuses a half-configured VAPID triple", () => {
    for (const key of [
      "PUSH_VAPID_PUBLIC_KEY",
      "PUSH_VAPID_PRIVATE_KEY",
      "PUSH_VAPID_SUBJECT",
    ] as const) {
      const partial: Record<string, string> = { ...VAPID_ENV };
      delete partial[key];
      expect(() => loadConfig({ ...BASE_ENV, ...partial })).toThrow(
        /must all be set together/,
      );
    }
  });

  it("names the decoded length when a VAPID key is the wrong size", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        ...VAPID_ENV,
        // The private key's 32 bytes, offered as the public key.
        PUSH_VAPID_PUBLIC_KEY: VAPID_ENV.PUSH_VAPID_PRIVATE_KEY,
      }),
    ).toThrow(/PUSH_VAPID_PUBLIC_KEY must decode to exactly 65 bytes/);
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        ...VAPID_ENV,
        PUSH_VAPID_PRIVATE_KEY: "not-a-real-key",
      }),
    ).toThrow(/generate-vapid-keys/);
  });

  it("requires a mailto: or https: VAPID subject", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        ...VAPID_ENV,
        PUSH_VAPID_SUBJECT: "admin@example.test",
      }),
    ).toThrow(/mailto:/);
    expect(
      loadConfig({
        ...BASE_ENV,
        ...VAPID_ENV,
        PUSH_VAPID_SUBJECT: "https://example.test/contact",
      }).PUSH_VAPID_SUBJECT,
    ).toBe("https://example.test/contact");
  });
});

describe("trustProxyValue", () => {
  it("defaults to no proxy", () => {
    expect(trustProxyValue(undefined)).toBe(false);
    expect(trustProxyValue("")).toBe(false);
    expect(trustProxyValue("false")).toBe(false);
  });

  it("parses booleans, hop counts, and address lists", () => {
    expect(trustProxyValue("true")).toBe(true);
    expect(trustProxyValue("2")).toBe(2);
    expect(trustProxyValue("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(trustProxyValue("127.0.0.1, 10.0.0.0/8")).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
    ]);
  });
});
