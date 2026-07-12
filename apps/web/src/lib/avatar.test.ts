import { expect, it } from "vitest";

import { avatarUrl, nameInitial } from "./avatar.js";

it("lowercases the character name, matching chat3client's avatarURL", () => {
  expect(avatarUrl("Amber Vale")).toBe(
    "https://static.f-list.net/images/avatar/amber vale.png",
  );
});

it("refuses names outside the safe charset", () => {
  expect(avatarUrl("nope/../etc")).toBeUndefined();
  expect(avatarUrl("<script>")).toBeUndefined();
});

it("derives the fallback initial", () => {
  expect(nameInitial("amber Vale")).toBe("A");
});
