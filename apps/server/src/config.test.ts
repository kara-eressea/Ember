import { describe, expect, it } from "vitest";
import { loadConfig, trustProxyValue } from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgres://emberchat:emberchat@localhost:5432/emberchat",
  AUTH_SECRET: "unit-test-secret-0123456789abcdef-xyz",
};

describe("loadConfig", () => {
  it("parses a minimal env and applies defaults", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.FCHAT_URL).toBe("wss://chat.f-list.net/chat2");
    expect(config.PORT).toBe(3000);
    expect(config.TRUST_PROXY).toBeUndefined();
  });

  it("refuses the .env.example placeholder AUTH_SECRET", () => {
    expect(() =>
      loadConfig({
        ...BASE_ENV,
        AUTH_SECRET: "dev-only-secret-change-me-0000000000",
      }),
    ).toThrow(/placeholder/);
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
