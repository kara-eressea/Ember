import { describe, expect, it } from "vitest";
import { parseBanlistLine } from "./banlist.js";

describe("parseBanlistLine", () => {
  it("reads the names out of a populated banlist line", () => {
    expect(
      parseBanlistLine("Channel bans for Potting Shed: Sorrel Vane."),
    ).toEqual(["Sorrel Vane"]);
    expect(
      parseBanlistLine(
        "Channel bans for Mod Bench: Birch Rowan, Nyx Firemane.",
      ),
    ).toEqual(["Birch Rowan", "Nyx Firemane"]);
  });

  it("returns an empty list for an explicit no-bans line", () => {
    expect(parseBanlistLine("There are no bans set on Potting Shed.")).toEqual(
      [],
    );
    expect(parseBanlistLine("This channel has no bans.")).toEqual([]);
  });

  it("tolerates missing trailing period and extra spacing", () => {
    expect(
      parseBanlistLine("Channel bans for Attic:  Birch Rowan ,  Nyx Firemane "),
    ).toEqual(["Birch Rowan", "Nyx Firemane"]);
  });

  it("returns null for lines that are not a banlist answer", () => {
    expect(parseBanlistLine("Sorrel Vane was kicked from the channel.")).toBe(
      null,
    );
    expect(parseBanlistLine("Rue Alder set the room to invite-only.")).toBe(
      null,
    );
    expect(parseBanlistLine("")).toBe(null);
  });
});
