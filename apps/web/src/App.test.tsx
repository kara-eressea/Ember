import { expect, it } from "vitest";

import { App } from "./App.js";

it("exports a component", () => {
  expect(typeof App).toBe("function");
});
