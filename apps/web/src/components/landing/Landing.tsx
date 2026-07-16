// Landing page (COMPONENTS.md §15) — nav, hero, feature cards. The scaled
// live client preview joins in step 10 once the app shell exists.

import { Link } from "react-router";
import { appConfig } from "../../lib/config.js";
import styles from "./landing.module.css";

const FEATURES = [
  {
    glyph: "⚲",
    title: "Stay online",
    body: "The server holds your session — close the tab and keep your place. Catch up on everything you missed when you return.",
  },
  {
    glyph: "☆",
    title: "Every identity, one login",
    body: "Connect several characters side by side and switch instantly. Each keeps its own channels, messages, and presence.",
  },
  {
    glyph: "Ⓜ",
    title: "Write in Markdown",
    body: "Compose with Markdown and live preview — it goes out as the BBCode everyone else expects.",
  },
];

export function Landing() {
  const { appName } = appConfig();
  return (
    <div className={styles.page}>
      <nav className={styles.nav}>
        <span className={styles.brand}>
          <span className={styles.brandChip}>
            {appName.charAt(0).toUpperCase()}
          </span>
          {appName.toLowerCase()}
        </span>
        <span className={styles.navSpacer} />
        <Link className={styles.accentButton} to="/login">
          Log in
        </Link>
      </nav>

      <main className={styles.hero}>
        <p className={styles.eyebrow}>a third-party F-Chat client</p>
        <h1 className={styles.heading}>
          The chat stays warm while you're away.
        </h1>
        <p className={styles.lede}>
          {appName} keeps your F-Chat characters online from the server side —
          with missed-message catch-up, Markdown composing, and multi-device
          login on top.
        </p>
        <div className={styles.ctaRow}>
          <Link className={styles.accentButton} to="/login">
            Log in ↗
          </Link>
        </div>
        <p className={styles.trustLine}>
          open source · MIT · your F-List password is never stored
        </p>
      </main>

      <section className={styles.features}>
        {FEATURES.map((feature) => (
          <div key={feature.title} className={styles.featureCard}>
            <span className={styles.featureGlyph}>{feature.glyph}</span>
            <h2 className={styles.featureTitle}>{feature.title}</h2>
            <p className={styles.featureBody}>{feature.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
