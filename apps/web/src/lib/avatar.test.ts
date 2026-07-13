import { expect, it } from "vitest";

import { avatarUrl, eiconUrl, nameInitial } from "./avatar.js";

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

it("builds eicon gallery URLs, lowercased, dots allowed", () => {
  expect(eiconUrl("Tea.Time-2")).toBe(
    "https://static.f-list.net/images/eicon/tea.time-2.gif",
  );
  expect(eiconUrl("nope/../etc")).toBeUndefined();
});
