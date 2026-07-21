import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hydrateTheme, themeVariables } from "./theme.js";
import {
  BASE_THEMES,
  genderColorVar,
  GENDER_PALETTE,
  GENDER_PALETTE_LIGHT,
  mix,
  nickColor,
  NICK_PALETTE,
} from "./tokens.js";

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

  it("parchment flips to the light status/nick/bbc palettes (M9)", () => {
    const vars = themeVariables("dusk", "parchment");
    expect(vars["--eb-bg"]).toBe(BASE_THEMES.parchment.bg);
    // Light-ground status colors, dark-enough for AA as text.
    expect(vars["--eb-ok"]).toBe("#54803a");
    // [color=white] must stay legible on paper — it maps to the ink text.
    expect(vars["--eb-bbc-white"]).toBe(BASE_THEMES.parchment.text);
    // The light nick palette rides the same var slots (#186: the darkened
    // mix(c, text, 0.52) set — legible on paper).
    expect(vars["--eb-nick-0"]).toBe("#695c72");
    // The derivation structure is untouched — soft still leans to bg.
    expect(vars["--eb-accent-soft"]).toBe(
      mix("#a892c6", BASE_THEMES.parchment.bg, 0.84),
    );
  });

  it("writes the readable-meta neutral per theme (#186)", () => {
    expect(themeVariables("dusk")["--eb-meta"]).toBe("#988e83");
    expect(themeVariables("dusk", "charcoal")["--eb-meta"]).toBe("#8b8377");
    expect(themeVariables("dusk", "parchment")["--eb-meta"]).toBe("#696154");
  });

  it("derives accentText: near-raw on dark, darkened on parchment (#186)", () => {
    // accentText = mix(accent, text, 0.04 dark / 0.62 parchment).
    expect(themeVariables("dusk")["--eb-accent-text"]).toBe("#ab95c7");
    expect(themeVariables("clay")["--eb-accent-text"]).toBe("#c9816f");
    expect(themeVariables("dusk", "parchment")["--eb-accent-text"]).toBe(
      "#5c5262",
    );
    expect(themeVariables("moss", "parchment")["--eb-accent-text"]).toBe(
      "#505b42",
    );
  });

  it("writes the dark gender palette on dark grounds (#177)", () => {
    const vars = themeVariables("dusk", "slate");
    expect(vars["--eb-gender-male"]).toBe("#6ea8ff");
    expect(vars["--eb-gender-female"]).toBe("#f28fb8");
    expect(vars["--eb-gender-male-herm"]).toBe("#69c0e0");
    expect(vars["--eb-gender-cunt-boy"]).toBe("#8fc873");
  });

  it("flips to the light gender palette on parchment (#177)", () => {
    const vars = themeVariables("dusk", "parchment");
    expect(vars["--eb-gender-male"]).toBe("#2f5fb0");
    expect(vars["--eb-gender-female"]).toBe("#a63368");
    expect(vars["--eb-gender-transgender"]).toBe("#276b5b");
  });

  it("every gender colour clears AA (4.5:1) on its member-list ground", () => {
    const lum = (hex: string) => {
      const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const lin = ch.map((v) =>
        v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    // Dark palette checked against the lighter of the two dark side2 grounds.
    const darkGround = BASE_THEMES.slate.side2;
    for (const hex of Object.values(GENDER_PALETTE)) {
      expect(ratio(hex, darkGround)).toBeGreaterThanOrEqual(4.5);
    }
    const lightGround = BASE_THEMES.parchment.side2;
    for (const hex of Object.values(GENDER_PALETTE_LIGHT)) {
      expect(ratio(hex, lightGround)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("colorblind mode swaps status hues per ground (M9)", () => {
    expect(themeVariables("dusk", "slate", true)["--eb-ok"]).toBe("#56b4e9");
    expect(themeVariables("dusk", "parchment", true)["--eb-ok"]).toBe(
      "#2a6f9e",
    );
    // Moss's warn shift folds into whichever set is active.
    expect(themeVariables("moss", "slate", true)["--eb-warn"]).toBe("#e6b625");
  });
});

describe("themeVariables — retuned --eb-bbc-* (#205)", () => {
  it("dark themes share the normalized hue set from the toolbar spec", () => {
    const vars = themeVariables("dusk");
    expect(vars["--eb-bbc-red"]).toBe("#e08a6a");
    expect(vars["--eb-bbc-orange"]).toBe("#e6a75a");
    expect(vars["--eb-bbc-yellow"]).toBe("#d8c06a");
    expect(vars["--eb-bbc-pink"]).toBe("#c294b0");
    expect(vars["--eb-bbc-green"]).toBe("#8bb173");
    expect(vars["--eb-bbc-cyan"]).toBe("#79b6b6");
    expect(vars["--eb-bbc-blue"]).toBe("#8f9bc9");
    expect(vars["--eb-bbc-purple"]).toBe("#a892c6");
    expect(vars["--eb-bbc-brown"]).toBe("#c0906a");
    expect(vars["--eb-bbc-black"]).toBe("#8a8078");
    expect(vars["--eb-bbc-gray"]).toBe("#a89e92");
    expect(vars["--eb-bbc-white"]).toBe("#ece7e0");
    // Charcoal shares the same set — one dark set, per the spec.
    expect(themeVariables("dusk", "charcoal")["--eb-bbc-red"]).toBe("#e08a6a");
  });

  it("parchment darkens via mix(name, text, .52), white→text, black→heading", () => {
    const vars = themeVariables("dusk", "parchment");
    const { text, heading } = BASE_THEMES.parchment;
    expect(vars["--eb-bbc-red"]).toBe(mix("#e08a6a", text, 0.52));
    expect(vars["--eb-bbc-gray"]).toBe(mix("#a89e92", text, 0.52));
    expect(vars["--eb-bbc-white"]).toBe(text);
    expect(vars["--eb-bbc-black"]).toBe(heading);
  });
});

describe("nickColor", () => {
  it("is deterministic and hands out a theme var in palette range", () => {
    expect(nickColor("Amber Vale")).toBe(nickColor("Amber Vale"));
    expect(nickColor("Nyx Firemane")).toMatch(/^var\(--eb-nick-[0-7]\)$/);
    // Every slot the vars can reference exists in both palettes.
    expect(NICK_PALETTE).toHaveLength(8);
  });
});

describe("genderColorVar", () => {
  it("maps wire genders to their token, case-insensitively", () => {
    expect(genderColorVar("Male")).toBe("var(--eb-gender-male)");
    expect(genderColorVar("male-herm")).toBe("var(--eb-gender-male-herm)");
    expect(genderColorVar("Cunt-boy")).toBe("var(--eb-gender-cunt-boy)");
  });

  it("returns undefined for None, unknown, and missing genders", () => {
    expect(genderColorVar("None")).toBeUndefined();
    expect(genderColorVar("Wizard")).toBeUndefined();
    expect(genderColorVar(undefined)).toBeUndefined();
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
      documentElement: { style: { setProperty }, classList: { toggle() {} } },
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
