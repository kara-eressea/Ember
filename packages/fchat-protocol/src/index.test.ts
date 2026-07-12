import { expect, it } from "vitest";

it("module loads", async () => {
  await expect(import("./index.js")).resolves.toBeDefined();
});
