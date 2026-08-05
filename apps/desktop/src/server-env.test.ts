import { describe, expect, it } from "vitest";
import { buildServerEnv } from "./server-env.js";

const options = {
  port: 49_231,
  dataDir: "/Users/someone/Library/Application Support/EmberChat/db",
  webDist: "/repo/apps/web/dist",
  authSecret: "a".repeat(43),
  clientVersion: "1.2.3",
};

describe("buildServerEnv", () => {
  it("is the server's complete environment, exactly", () => {
    expect(buildServerEnv(options)).toEqual({
      NODE_ENV: "production",
      DB_DRIVER: "pglite",
      PGLITE_DATA_DIR:
        "/Users/someone/Library/Application Support/EmberChat/db",
      HOST: "127.0.0.1",
      PORT: "49231",
      APP_BASE_URL: "http://127.0.0.1:49231",
      WEB_DIST: "/repo/apps/web/dist",
      AUTH_SECRET: "a".repeat(43),
      RETENTION_POLICY: "forever",
      CLIENT_VERSION: "1.2.3",
    });
  });

  it("admits the renderer's own origin to the gateway allowlist", () => {
    // APP_BASE_URL is what apps/server derives the WebSocket origin allowlist
    // from, so it must be the very origin the window loads.
    const env = buildServerEnv(options);
    expect(env.APP_BASE_URL).toBe(`http://${env.HOST}:${env.PORT}`);
  });

  it("never inherits the ambient environment", () => {
    // A developer's shell has DATABASE_URL and AUTH_SECRET in it. Neither may
    // reach the embedded bouncer.
    const env = buildServerEnv(options);
    expect(Object.keys(env).toSorted()).toEqual([
      "APP_BASE_URL",
      "AUTH_SECRET",
      "CLIENT_VERSION",
      "DB_DRIVER",
      "HOST",
      "NODE_ENV",
      "PGLITE_DATA_DIR",
      "PORT",
      "RETENTION_POLICY",
      "WEB_DIST",
    ]);
    expect(env).not.toHaveProperty("DATABASE_URL");
  });
});
