import { describe, expect, it } from "vitest";
import type { MessageDto } from "@emberchat/protocol";
import { buildRows } from "./log-rows.js";

function msg(id: number, sentByUs = false): MessageDto {
  return {
    id,
    senderCharacter: sentByUs ? "Me" : "Nyx Firemane",
    kind: "msg",
    bbcode: `message ${String(id)}`,
    sentByUs,
    createdAt: "2026-07-13T12:00:00.000Z",
  };
}

function shape(rows: ReturnType<typeof buildRows>): string[] {
  return rows.map((row) =>
    row.type === "message" ? `m${String(row.message.id)}` : row.type,
  );
}

describe("buildRows new-since divider", () => {
  it("sits above the first inbound message past the frozen cursor", () => {
    const rows = buildRows([msg(1), msg(2), msg(3)], 1);
    expect(shape(rows)).toEqual(["divider", "m1", "new", "m2", "m3"]);
  });

  it("skips own sends: they are never 'new to read'", () => {
    const rows = buildRows([msg(1), msg(2, true), msg(3)], 1);
    expect(shape(rows)).toEqual(["divider", "m1", "m2", "new", "m3"]);
  });

  it("renders no divider when everything new is our own", () => {
    const rows = buildRows([msg(1), msg(2, true)], 1);
    expect(shape(rows)).toEqual(["divider", "m1", "m2"]);
  });

  it("renders no divider when everything is read or nothing was ever read", () => {
    expect(shape(buildRows([msg(1), msg(2)], 2))).toEqual([
      "divider",
      "m1",
      "m2",
    ]);
    expect(shape(buildRows([msg(1), msg(2)], null))).toEqual([
      "divider",
      "m1",
      "m2",
    ]);
  });

  it("marks the top when the whole buffer is past the cursor", () => {
    const rows = buildRows([msg(5), msg(6)], 2);
    expect(shape(rows)).toEqual(["divider", "new", "m5", "m6"]);
  });
});
