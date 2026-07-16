// Daily update check (M7): reads the GitHub Releases API and remembers
// whether a newer version than the running one exists. Server-side on
// purpose — the SPA's CSP allows no third-party connects, and one switch
// (UPDATE_CHECK_ENABLED=false) turns the phone-home off for the whole
// instance. Failures are logged and retried next tick; the check never
// affects anything but the hint.

import type { SessionLogger } from "../session-engine/fchat-session.js";

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckerOptions {
  /** The running version ("0.5.0" or "v0.5.0" — the v is tolerated). */
  readonly currentVersion: string;
  /** "owner/repo" the releases are read from. */
  readonly repo: string;
  readonly enabled: boolean;
  readonly logger?: SessionLogger;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly checkIntervalMs?: number;
}

export interface UpdateStatus {
  readonly version: string;
  readonly updateAvailable: boolean;
  readonly latestVersion: string | undefined;
  readonly releasesUrl: string;
}

/**
 * Numeric dotted-version compare; returns > 0 when `a` is newer than `b`.
 * Tolerates a leading "v" and unequal segment counts; anything non-numeric
 * compares as 0 (a garbage tag never announces an update).
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/, "")
      .split(/[.+-]/, 3)
      .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export class UpdateChecker {
  readonly #options: UpdateCheckerOptions;
  readonly #fetch: typeof fetch;
  #timer: NodeJS.Timeout | undefined;
  #latest: string | undefined;

  constructor(options: UpdateCheckerOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  start(): void {
    if (!this.#options.enabled || this.#timer) {
      return;
    }
    void this.checkOnce();
    this.#timer = setInterval(() => {
      void this.checkOnce();
    }, this.#options.checkIntervalMs ?? UPDATE_CHECK_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /** One check; exposed for tests. Never throws. */
  async checkOnce(): Promise<void> {
    try {
      const response = await this.#fetch(
        `https://api.github.com/repos/${this.#options.repo}/releases/latest`,
        { headers: { accept: "application/vnd.github+json" } },
      );
      if (!response.ok) {
        this.#options.logger?.warn(
          { status: response.status },
          "update check got a non-OK response",
        );
        return;
      }
      const body = (await response.json()) as { tag_name?: unknown };
      if (typeof body.tag_name === "string" && body.tag_name !== "") {
        this.#latest = body.tag_name;
      }
    } catch (error) {
      this.#options.logger?.warn({ err: error }, "update check failed");
    }
  }

  get status(): UpdateStatus {
    const latest = this.#latest;
    return {
      version: this.#options.currentVersion,
      updateAvailable:
        latest !== undefined &&
        compareVersions(latest, this.#options.currentVersion) > 0,
      latestVersion: latest,
      releasesUrl: `https://github.com/${this.#options.repo}/releases`,
    };
  }
}
