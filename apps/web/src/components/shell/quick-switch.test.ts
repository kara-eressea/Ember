import { describe, expect, it } from "vitest";
import { matchScore, rankCandidates } from "./quick-switch.js";

const c = (id: string, label: string) => ({
  id,
  kind: "channel" as const,
  label,
  path: `/c/${id}`,
});

describe("matchScore", () => {
  it("requires every character in order", () => {
    expect(matchScore("fp", "Frontpage")).toBeDefined();
    expect(matchScore("pf", "Frontpage")).toBeUndefined();
  });

  it("prefers prefixes over word starts over scattered hits", () => {
    const prefix = matchScore("front", "Frontpage")!;
    const wordStart = matchScore("page", "Front Page")!;
    const scattered = matchScore("rge", "Frontpage")!;
    expect(prefix).toBeLessThan(wordStart);
    expect(wordStart).toBeLessThan(scattered);
  });

  it("empty query matches everything at score 0", () => {
    expect(matchScore("", "anything")).toBe(0);
  });
});

describe("rankCandidates", () => {
  it("ranks by score and keeps incoming order on ties", () => {
    const ranked = rankCandidates("de", [
      c("1", "Development"),
      c("2", "Design Den"),
      c("3", "Garden"),
    ]);
    // Both prefix matches beat the scattered one; the tie keeps 1 before 2.
    expect(ranked.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("caps the result list", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      c(String(i), `chan${String(i)}`),
    );
    expect(rankCandidates("chan", many)).toHaveLength(12);
  });
});
