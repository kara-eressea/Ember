// Slash-command autocomplete (#235): a popover above the message box that
// lists the commands matching what's typed, each with its signature and a
// plain-language line. Arrow keys move the selection, Tab/Enter complete,
// Escape dismisses — the keyboard wiring lives in the Composer; this renders
// the list and reports clicks/hovers. Styling reuses the composer popover
// tokens (see the eicon picker).

import type { SlashHint } from "./slash.js";
import styles from "./chat.module.css";

export function SlashAutocomplete({
  suggestions,
  activeIndex,
  onHover,
  onSelect,
}: {
  suggestions: readonly SlashHint[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (hint: SlashHint) => void;
}) {
  return (
    <div
      className={styles.slashPopover}
      role="listbox"
      aria-label="Slash commands"
      data-testid="slash-autocomplete"
    >
      {suggestions.map((hint, index) => (
        <button
          key={hint.name}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={`${styles.slashItem} ${
            index === activeIndex ? (styles.slashItemActive ?? "") : ""
          }`}
          // The composer input keeps focus; a press must not steal it before
          // the click lands (otherwise the textarea blurs and the caret jumps).
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onMouseEnter={() => {
            onHover(index);
          }}
          onClick={() => {
            onSelect(hint);
          }}
        >
          <span className={styles.slashItemUsage}>{hint.usage}</span>
          <span className={styles.slashItemDesc}>{hint.description}</span>
        </button>
      ))}
    </div>
  );
}
