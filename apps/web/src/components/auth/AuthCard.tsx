import type { ReactNode } from "react";
import { Wordmark } from "../common/Wordmark.js";
import styles from "./auth.module.css";

export interface AuthCardProps {
  title: string;
  sub: ReactNode;
  wide?: boolean;
  children: ReactNode;
}

/**
 * The auth panel (COMPONENTS.md §13/§14): a centred card above the phone tier,
 * the whole screen on it (#535).
 *
 * `auth-panel` is the testid the phone E2E measures the box of — the tier
 * question is "does this fill the screen", and a class name cannot answer it.
 */
export function AuthCard({
  title,
  sub,
  wide = false,
  children,
}: AuthCardProps) {
  return (
    <div className={styles.backdrop}>
      <div
        className={wide ? styles.cardWide : styles.card}
        data-testid="auth-panel"
      >
        <div className={styles.brand}>
          <Wordmark />
        </div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.sub}>{sub}</p>
        {children}
      </div>
    </div>
  );
}
