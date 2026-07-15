import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hydrateTheme, themeVariables } from "./theme.js";
import { BASE_THEMES, mix, nickColor, NICK_PALETTE } from "./tokens.js";

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

  it("derives from the charcoal neutrals when asked", () => {
    const vars = themeVariables("dusk", "charcoal");
    expect(vars["--eb-bg"]).toBe(BASE_THEMES.charcoal.bg);
    // Derived colors move with the base: accentSoft leans toward the new bg.
    expect(vars["--eb-accent-soft"]).toBe(
      mix("#a892c6", BASE_THEMES.charcoal.bg, 0.84),
    );
  });
});

describe("nickColor", () => {
  it("is deterministic and stays in the palette", () => {
    expect(nickColor("Amber Vale")).toBe(nickColor("Amber Vale"));
    expect(NICK_PALETTE).toContain(nickColor("Nyx Firemane"));
  });
});

describe("hydrateTheme", () => {
  // Node environment — stub the DOM surface the theme writes to.
  const stored = new Map<string, string>();
  const setProperty = vi.fn();

  beforeEach(() => {
    stored.clear();
    setProperty.mockClear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
    });
    vi.stubGlobal("document", {
      documentElement: { style: { setProperty } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies server accent + base theme and refreshes the flash cache", () => {
    hydrateTheme({ accent: "moss", baseTheme: "charcoal" });
    expect(stored.get("eb.accent")).toBe("moss");
    expect(stored.get("eb.baseTheme")).toBe("charcoal");
    expect(setProperty).toHaveBeenCalledWith("--eb-accent", "#88ac72");
    expect(setProperty).toHaveBeenCalledWith(
      "--eb-bg",
      BASE_THEMES.charcoal.bg,
    );
  });

  it("skips unknown ids per field — a newer server's value must not repaint to default", () => {
    stored.set("eb.accent", "clay");
    stored.set("eb.baseTheme", "charcoal");
    hydrateTheme({ accent: "neon", baseTheme: "hologram" });
    expect(stored.get("eb.accent")).toBe("clay");
    expect(stored.get("eb.baseTheme")).toBe("charcoal");
    expect(setProperty).not.toHaveBeenCalled();

    // A valid field still applies even next to an unknown one.
    hydrateTheme({ accent: "moss", baseTheme: "hologram" });
    expect(stored.get("eb.accent")).toBe("moss");
    expect(stored.get("eb.baseTheme")).toBe("charcoal");
  });

  it("no-ops when the cache already matches", () => {
    stored.set("eb.accent", "clay");
    stored.set("eb.baseTheme", "slate");
    hydrateTheme({ accent: "clay", baseTheme: "slate" });
    expect(setProperty).not.toHaveBeenCalled();
  });
});
