// Kink-choice vocabulary shared by the Kinks tab and the Compare view
// (§8): glyph badges are the colorblind-safe channel, colors reinforce.

export const CHOICES = [
  { id: "fave", label: "Fave", glyph: "♥", color: "var(--eb-ok)" },
  {
    id: "yes",
    label: "Yes",
    glyph: "+",
    color: "color-mix(in srgb, var(--eb-ok) 50%, var(--eb-warn))",
  },
  { id: "maybe", label: "Maybe", glyph: "~", color: "var(--eb-warn)" },
  { id: "no", label: "No", glyph: "×", color: "var(--eb-danger)" },
] as const;

export type ChoiceId = (typeof CHOICES)[number]["id"];

export function choiceOf(id: string) {
  return CHOICES.find((choice) => choice.id === id);
}
