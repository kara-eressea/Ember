import { expect, it } from "vitest";

import { PROTOCOL_VERSION } from "./index.js";

it("exposes the protocol version", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
