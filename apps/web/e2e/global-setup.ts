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
  let sim: FchatSim | undefined;
  let container: Awaited<ReturnType<PostgreSqlContainer["start"]>> | undefined;
  let server: ChildProcess | undefined;

  const teardown = async () => {
    if (server) {
      const child = server;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
      });
    }
    await container?.stop();
    await sim?.stop();
  };

  try {
    // A tiny flood window lets the chat spec seed history quickly; the
    // server's rate gate follows the live VAR, so it speeds up equally.
    sim = new FchatSim({ serverVars: { msg_flood: 0.05 } });
    await sim.start();
    // Specs drive a second character straight against the sim (the "other
    // side" of the relay); Playwright forwards process.env to workers.
    process.env["FCHAT_SIM_WS_URL"] = sim.wsUrl;
    process.env["FCHAT_SIM_TICKET_URL"] = sim.ticketUrl;
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    server = spawn(process.execPath, [SERVER_ENTRY], {
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
    await waitForHealthy(
      `http://127.0.0.1:${String(API_PORT)}/healthz`,
      server,
    );
  } catch (error) {
    // Partial-failure hygiene: a leaked server child would keep the API port
    // bound and fail every subsequent run's health wait.
    await teardown();
    throw error;
  }

  return teardown;
}
