import { describe, expect, it } from "vitest";
import type { MessageDto } from "@emberchat/protocol";
import { buildRows, GROUP_WINDOW_MS } from "./log-rows.js";

function msg(
  id: number,
  sentByUs = false,
  overrides: Partial<MessageDto> = {},
): MessageDto {
  return {
    id,
    senderCharacter: sentByUs ? "Me" : "Nyx Firemane",
    kind: "msg",
    bbcode: `message ${String(id)}`,
    sentByUs,
    mention: false,
    createdAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
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

describe("buildRows ignore filtering", () => {
  it("hides ignored senders case-insensitively but never our own sends", () => {
    const rows = buildRows([msg(1), msg(2, true), msg(3)], null, [
      "NYX FIREMANE",
    ]);
    expect(shape(rows)).toEqual(["divider", "m2"]);
  });

  it("drops the day divider when a day is entirely ignored", () => {
    const rows = buildRows([msg(1), msg(2)], null, ["Nyx Firemane"]);
    expect(shape(rows)).toEqual([]);
  });

  it("an empty ignore list changes nothing", () => {
    const rows = buildRows([msg(1), msg(2)], 1, []);
    expect(shape(rows)).toEqual(["divider", "m1", "new", "m2"]);
  });
});

describe("buildRows group-consecutive (Appearance pref)", () => {
  const GROUP = { groupConsecutive: true };

  function groupedShape(rows: ReturnType<typeof buildRows>): string[] {
    return rows.map((row) =>
      row.type === "message"
        ? `m${String(row.message.id)}${row.grouped ? "+" : ""}`
        : row.type,
    );
  }

  it("marks back-to-back rows from the same sender", () => {
    const rows = buildRows(
      [msg(1), msg(2), msg(3, true), msg(4, true), msg(5)],
      null,
      [],
      GROUP,
    );
    expect(groupedShape(rows)).toEqual([
      "divider",
      "m1",
      "m2+",
      "m3",
      "m4+",
      "m5",
    ]);
  });

  it("never groups when the pref is off", () => {
    const rows = buildRows([msg(1), msg(2)], null, []);
    expect(groupedShape(rows)).toEqual(["divider", "m1", "m2"]);
  });

  it("breaks the group across the new-divider and long gaps", () => {
    const later = new Date(
      Date.parse("2026-07-13T12:00:00.000Z") + GROUP_WINDOW_MS + 1000,
    ).toISOString();
    const rows = buildRows(
      [msg(1), msg(2), msg(3, false, { createdAt: later })],
      1,
      [],
      GROUP,
    );
    // m2 is past the cursor → the "new" divider interrupts; m3 is past the
    // window → fresh group even though the sender never changed.
    expect(groupedShape(rows)).toEqual(["divider", "m1", "new", "m2", "m3"]);
  });

  it("emotes neither group nor continue a group", () => {
    const rows = buildRows(
      [msg(1), msg(2, false, { bbcode: "/me waves" }), msg(3)],
      null,
      [],
      GROUP,
    );
    expect(groupedShape(rows)).toEqual(["divider", "m1", "m2", "m3"]);
  });

  it("presence lines break groups", () => {
    const rows = buildRows([msg(1), msg(2)], null, [], {
      ...GROUP,
      presence: [
        {
          key: "p:1",
          kind: "join",
          character: "Tally Marsh",
          createdAt: "2026-07-13T12:00:00.000Z",
        },
      ],
    });
    // The join line lands between m1 and m2 (same timestamp sorts before
    // the next message) — m2 no longer continues m1.
    expect(groupedShape(rows)).toEqual(["presence", "divider", "m1", "m2+"]);
  });
});

describe("buildRows presence lines (show join/part/quit pref)", () => {
  const line = (key: string, createdAt: string, character = "Tally Marsh") => ({
    key,
    kind: "join" as const,
    character,
    createdAt,
  });

  it("merges by timestamp, with the common tail case after all messages", () => {
    const rows = buildRows([msg(1), msg(2)], null, [], {
      presence: [line("p:1", "2026-07-13T12:30:00.000Z")],
    });
    expect(shape(rows)).toEqual(["divider", "m1", "m2", "presence"]);
  });

  it("renders nothing without the option (pref off = caller passes none)", () => {
    const rows = buildRows([msg(1)], null, []);
    expect(shape(rows)).toEqual(["divider", "m1"]);
  });

  it("hides lines from ignored characters like their messages", () => {
    const rows = buildRows([msg(1, true)], null, ["tally marsh"], {
      presence: [line("p:1", "2026-07-13T12:30:00.000Z")],
    });
    expect(shape(rows)).toEqual(["divider", "m1"]);
  });
});

describe("buildRows ad hiding", () => {
  it("drops inbound ads when hideAds is set, keeping own ads", () => {
    const rows = buildRows(
      [msg(1), msg(2, false, { kind: "lrp" }), msg(3, true, { kind: "lrp" })],
      null,
      [],
      { hideAds: true },
    );
    expect(shape(rows)).toEqual(["divider", "m1", "m3"]);
  });

  it("keeps ads when hideAds is off", () => {
    const rows = buildRows([msg(1), msg(2, false, { kind: "lrp" })], null, [], {
      hideAds: false,
    });
    expect(shape(rows)).toEqual(["divider", "m1", "m2"]);
  });
});
