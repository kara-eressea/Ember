/**
 * The one part of starting the bouncer that has to know about Electron: making
 * the child. Everything about *what happens next* — readiness, retries,
 * stopping — is in `embedded-server.ts`, which imports no Electron and is
 * tested against a fake of this function (`ServerRuntime.fork`).
 *
 * Both branches and the reasoning behind the split are documented on
 * `serverChildMechanism`; this file is the wiring.
 */

import { spawn } from "node:child_process";
import { utilityProcess } from "electron";
import {
  nodeChildLaunch,
  serverChildMechanism,
  stopChildOnExit,
  type ServerChild,
} from "./embedded-server.js";

export function forkServerChild(
  entry: string,
  env: Record<string, string>,
): ServerChild {
  if (serverChildMechanism(process.platform) === "utility-process") {
    return utilityProcess.fork(entry, [], {
      serviceName: "emberchat-server",
      env,
      stdio: "pipe",
    });
  }
  const launch = nodeChildLaunch(process.execPath, entry, env);
  const child = spawn(launch.command, [...launch.args], launch.options);
  stopChildOnExit(child);
  return child;
}
