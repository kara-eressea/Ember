import { describe, expect, it } from "vitest";
import {
  adTitle,
  commitTag,
  counterLevel,
  lineOfOffset,
  LOSSINESS_COPY,
  reorder,
  stripModel,
} from "./ad-center-logic.js";
import type { MdLossDiagnostic, MdLossKind } from "@emberchat/markdown-bbcode";

describe("counterLevel", () => {
  it("walks normal → amber (90%) → red (98%) → cap", () => {
    expect(counterLevel(0, 1000)).toBe("normal");
    expect(counterLevel(899, 1000)).toBe("normal");
    expect(counterLevel(900, 1000)).toBe("amber");
    expect(counterLevel(979, 1000)).toBe("amber");
    expect(counterLevel(980, 1000)).toBe("red");
    expect(counterLevel(999, 1000)).toBe("red");
    expect(counterLevel(1000, 1000)).toBe("cap");
  });

  it("treats a nonsense limit as capped rather than dividing by zero", () => {
    expect(counterLevel(5, 0)).toBe("cap");
  });
});

describe("lineOfOffset", () => {
  it("maps offsets to 1-based lines", () => {
    const source = "one\ntwo\nthree";
    expect(lineOfOffset(source, 0)).toBe(1);
    expect(lineOfOffset(source, 3)).toBe(1);
    expect(lineOfOffset(source, 4)).toBe(2);
    expect(lineOfOffset(source, 8)).toBe(3);
    expect(lineOfOffset(source, 999)).toBe(3);
  });
});

describe("commitTag", () => {
  it("trims, dedupes and enforces the caps", () => {
    expect(commitTag([], "  winter  ")).toEqual(["winter"]);
    expect(commitTag(["winter"], "winter")).toEqual(["winter"]);
    expect(commitTag(["winter"], "   ")).toEqual(["winter"]);
    expect(commitTag(["winter"], "x".repeat(31))).toEqual(["winter"]);
    const ten = Array.from({ length: 10 }, (_, i) => `t${String(i)}`);
    expect(commitTag(ten, "eleventh")).toEqual(ten);
  });
});

describe("stripModel", () => {
  const diag = (at: number): MdLossDiagnostic => ({
    kind: "unsupported-block",
    at,
    snippet: "#",
  });

  it("shows at most four rows and counts the overflow", () => {
    expect(stripModel([diag(1)])).toEqual({
      visible: [diag(1)],
      overflow: 0,
    });
    const six = [diag(1), diag(2), diag(3), diag(4), diag(5), diag(6)];
    const model = stripModel(six);
    expect(model.visible).toHaveLength(4);
    expect(model.overflow).toBe(2);
  });
});

describe("LOSSINESS_COPY", () => {
  it("covers every diagnostic kind with jargon-free copy", () => {
    const kinds: MdLossKind[] = [
      "unsupported-block",
      "underscore-emphasis",
      "unsupported-bbcode",
      "invalid-bbcode-param",
      "unterminated-bbcode",
      "unterminated-emphasis",
    ];
    for (const kind of kinds) {
      const entry = LOSSINESS_COPY[kind];
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.copy.length).toBeGreaterThan(0);
      // The plain-language rule: no wire/protocol vocabulary in UI copy.
      for (const banned of ["LRP", "lfrp", "BBCode", "wire", "409"]) {
        expect(entry.label).not.toContain(banned);
        expect(entry.copy).not.toContain(banned);
      }
    }
  });
});

describe("adTitle", () => {
  it("uses the first non-empty line and falls back for blank ads", () => {
    expect(adTitle("**Arctic fox** seeks scenes\nmore text")).toBe(
      "**Arctic fox** seeks scenes",
    );
    expect(adTitle("   ")).toBe("(empty ad)");
  });
});

describe("reorder", () => {
  it("moves an element and leaves the original untouched", () => {
    const list = ["a", "b", "c", "d"];
    expect(reorder(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorder(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorder(list, 1, 1)).toBe(list);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });
});
