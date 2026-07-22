import { describe, expect, it } from "vitest";
import {
  nextNoteSaveState,
  noteSaveLabel,
  type NoteSaveState,
} from "./note-save.js";

describe("note-save state machine", () => {
  it("an edit always enters the saving state", () => {
    for (const from of [
      "idle",
      "saving",
      "saved",
      "error",
    ] as NoteSaveState[]) {
      expect(nextNoteSaveState(from, "edit")).toBe("saving");
    }
  });

  it("a commit only lands ✓ while still saving", () => {
    expect(nextNoteSaveState("saving", "saved")).toBe("saved");
    // A superseded resolve must not flash ✓ over a fresher state.
    expect(nextNoteSaveState("idle", "saved")).toBe("idle");
    expect(nextNoteSaveState("error", "saved")).toBe("error");
  });

  it("a failure only shows ⚠ while still saving", () => {
    expect(nextNoteSaveState("saving", "error")).toBe("error");
    expect(nextNoteSaveState("saved", "error")).toBe("saved");
  });

  it("reset clears back to idle from anywhere", () => {
    for (const from of [
      "idle",
      "saving",
      "saved",
      "error",
    ] as NoteSaveState[]) {
      expect(nextNoteSaveState(from, "reset")).toBe("idle");
    }
  });

  it("labels each visible state and shows nothing when idle", () => {
    expect(noteSaveLabel("idle")).toBeNull();
    expect(noteSaveLabel("saving")).toBe("Saving…");
    expect(noteSaveLabel("saved")).toBe("✓ Saved");
    expect(noteSaveLabel("error")).toBe("⚠ Not saved");
  });
});
