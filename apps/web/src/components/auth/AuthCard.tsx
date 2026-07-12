import type { ReactNode } from "react";
import { appConfig } from "../../lib/config.js";
import styles from "./auth.module.css";

export interface AuthCardProps {
  title: string;
  sub: ReactNode;
  wide?: boolean;
  children: ReactNode;
}

/** Centered auth card with the brand lockup (COMPONENTS.md §13). */
export function AuthCard({
  title,
  sub,
  wide = false,
  children,
}: AuthCardProps) {
  const { appName } = appConfig();
  return (
    <div className={styles.backdrop}>
      <div className={wide ? styles.cardWide : styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandChip}>
            {appName.charAt(0).toUpperCase()}
          </span>
          {appName.toLowerCase()}
        </div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.sub}>{sub}</p>
        {children}
      </div>
    </div>
  );
}
