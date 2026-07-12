// Standalone runner for manual poking (wscat) and local development:
//   pnpm --filter @emberline/fchat-sim build && pnpm --filter @emberline/fchat-sim start
// Port comes from FCHAT_SIM_PORT (default 9090).

import { FchatSim } from "./sim-server.js";
import { DEFAULT_WORLD } from "./world.js";

const port = Number(process.env["FCHAT_SIM_PORT"] ?? 9090);
const sim = new FchatSim({
  port,
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
