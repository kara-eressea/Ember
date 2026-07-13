// Standalone runner for manual poking (wscat), local development, and the
// docker-compose smoke profile. Port from FCHAT_SIM_PORT (default 9090);
// bind address from FCHAT_SIM_HOST (default loopback; 0.0.0.0 in a container).

import { FchatSim } from "./sim-server.js";
import { DEFAULT_WORLD } from "./world.js";

const port = Number(process.env["FCHAT_SIM_PORT"] ?? 9090);
const host = process.env["FCHAT_SIM_HOST"] ?? "127.0.0.1";
const sim = new FchatSim({
  port,
  host,
  log: (line) => console.log(line),
});

await sim.start();
console.log(`fchat-sim listening`);
console.log(`  chat:    ${sim.wsUrl}`);
console.log(`  tickets: ${sim.ticketUrl}`);
console.log(`accounts:`);
for (const [account, { password, characters }] of Object.entries(
  DEFAULT_WORLD.accounts,
)) {
  console.log(`  ${account} / ${password} → ${characters.join(", ")}`);
}

process.on("SIGINT", () => {
  void sim.stop().then(() => process.exit(0));
});
