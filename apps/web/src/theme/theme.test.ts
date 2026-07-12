import { describe, expect, it } from "vitest";

import { themeVariables } from "./theme.js";
import { mix, nickColor, NICK_PALETTE } from "./tokens.js";

describe("mix", () => {
  // The exact derived values documented for Dusk Purple in COMPONENTS.md.
  it("reproduces the documented Dusk derivations", () => {
    expect(mix("#a892c6", "#1b1917", 0.84)).toBe("#322c33"); // accentSoft
    expect(mix("#a892c6", "#1b1917", 0.5)).toBe("#62566f"); // accentMed
    expect(mix("#ece7e0", "#1b1917", 0.9)).toBe("#302e2b"); // codebg
  });

  it("is an endpoint-exact lerp", () => {
    expect(mix("#a892c6", "#1b1917", 0)).toBe("#a892c6");
    expect(mix("#a892c6", "#1b1917", 1)).toBe("#1b1917");
  });
});

describe("themeVariables", () => {
  it("derives the Dusk palette", () => {
    const vars = themeVariables("dusk");
    expect(vars["--eb-accent"]).toBe("#a892c6");
    expect(vars["--eb-accent-soft"]).toBe("#322c33");
    expect(vars["--eb-accent-med"]).toBe("#62566f");
    expect(vars["--eb-codebg"]).toBe("#302e2b");
    expect(vars["--eb-warn"]).toBe("#d0a24f");
  });

  it("shifts the warn dot for Moss Green", () => {
    expect(themeVariables("moss")["--eb-warn"]).toBe("#c9a25e");
    expect(themeVariables("amber")["--eb-warn"]).toBe("#d0a24f");
  });
});

describe("nickColor", () => {
  it("is deterministic and stays in the palette", () => {
    expect(nickColor("Amber Vale")).toBe(nickColor("Amber Vale"));
    expect(NICK_PALETTE).toContain(nickColor("Nyx Firemane"));
  });
});
