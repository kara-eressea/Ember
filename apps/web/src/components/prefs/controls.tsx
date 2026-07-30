// Preference control primitives (COMPONENTS.md §12) — shared by every pane
// of the Preferences window. Purely presentational: state lives with the
// pane, persistence goes through the gateway `prefs.set` patch.

import type { ReactNode } from "react";
import styles from "./prefs.module.css";

/** 38×22 pill switch. */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`${styles.toggle} ${checked ? styles.toggleOn : ""}`}
      onClick={() => {
        onChange(!checked);
      }}
    >
      <span className={styles.toggleKnob} />
    </button>
  );
}

/** Inline segmented control; the selected segment fills with accent. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={`${styles.segment} ${
            option.value === value ? styles.segmentActive : ""
          }`}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Stepped value control: − / value / +, stepping through a fixed list of
 * options. `format` renders the current value (e.g. "125%"). Buttons disable
 * at the ends so the value can never leave the supported set. */
export function Stepper<T extends number | string>({
  options,
  value,
  onChange,
  format,
  label,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  format: (value: T) => string;
  label: string;
}) {
  const index = options.indexOf(value);
  const current = index === -1 ? 0 : index;
  const atMin = current <= 0;
  const atMax = current >= options.length - 1;
  return (
    <div className={styles.stepper} role="group" aria-label={label}>
      <button
        type="button"
        className={styles.stepperButton}
        aria-label={`Decrease ${label}`}
        disabled={atMin}
        onClick={() => {
          if (!atMin) {
            onChange(options[current - 1] as T);
          }
        }}
      >
        −
      </button>
      <span className={styles.stepperValue} aria-label={label} role="status">
        {format(options[current] as T)}
      </span>
      <button
        type="button"
        className={styles.stepperButton}
        aria-label={`Increase ${label}`}
        disabled={atMax}
        onClick={() => {
          if (!atMax) {
            onChange(options[current + 1] as T);
          }
        }}
      >
        +
      </button>
    </div>
  );
}

/** Label (+ optional help) on the left, the control on the right. */
export function FieldRow({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.fieldRow}>
      <div className={styles.fieldText}>
        <div className={styles.fieldLabel}>{label}</div>
        {help !== undefined && <div className={styles.fieldHelp}>{help}</div>}
      </div>
      <div className={styles.fieldControl}>{children}</div>
    </div>
  );
}

/** Uppercase faint section label inside a pane. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <div className={styles.groupLabel}>{children}</div>;
}

/** 26px color circle; selected = double ring. */
export function Swatch({
  color,
  selected,
  label,
  onClick,
}: {
  color: string;
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={label}
      className={`${styles.swatch} ${selected ? styles.swatchSelected : ""}`}
      // `color` too: the selected ring is drawn in currentcolor.
      style={{ background: color, color }}
      onClick={onClick}
    />
  );
}
