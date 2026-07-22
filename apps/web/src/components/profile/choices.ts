// Kink-choice vocabulary shared by the Kinks tab and the Compare view
// (§8): glyph badges are the colorblind-safe channel, colors reinforce.
// Colours are the theme-normalized kink palette (--eb-kink-*, tokens.ts /
// theme.ts) — Rising/Horizon convention, retuned per ground so they hold on
// slate/charcoal and parchment alike (#278). Glyphs are the resilient
// second channel that survives the colourblind path.

export const CHOICES = [
  { id: "fave", label: "Fave", glyph: "♥", color: "var(--eb-kink-fave)" },
  { id: "yes", label: "Yes", glyph: "✓", color: "var(--eb-kink-yes)" },
  { id: "maybe", label: "Maybe", glyph: "~", color: "var(--eb-kink-maybe)" },
  { id: "no", label: "No", glyph: "✕", color: "var(--eb-kink-no)" },
] as const;

export type ChoiceId = (typeof CHOICES)[number]["id"];

export function choiceOf(id: string) {
  return CHOICES.find((choice) => choice.id === id);
}
