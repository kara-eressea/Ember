// Boots the real backend for the E2E suite: Postgres in a container, the
// fchat-sim F-Chat stand-in, and the built server as a child process (it
// migrates on boot). Returns the teardown that stops all three.

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { FchatSim } from "@emberline/fchat-sim";
import { API_PORT } from "../playwright.config.js";

const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/main.js", import.meta.url),
);

async function waitForHealthy(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `server exited with code ${String(child.exitCode)} during startup`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Not up yet.
    }
    await delay(500);
  }
  throw new Error(`server never became healthy at ${url}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const sim = new FchatSim();
  await sim.start();

  const container = await new PostgreSqlContainer("postgres:18-alpine").start();

  const server = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(API_PORT),
      DATABASE_URL: container.getConnectionUri(),
      AUTH_SECRET: "e2e-test-secret-0123456789abcdefghijklmn",
      AUTH_RATE_LIMIT_MAX: "1000",
      FCHAT_URL: sim.wsUrl,
      FLIST_API_URL: sim.httpUrl,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  await waitForHealthy(`http://127.0.0.1:${String(API_PORT)}/healthz`, server);

  return async () => {
    server.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      server.once("exit", () => {
        resolve();
      });
      setTimeout(() => {
        server.kill("SIGKILL");
        resolve();
      }, 5000);
    });
    await container.stop();
    await sim.stop();
  };
}
