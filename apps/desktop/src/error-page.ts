/**
 * What the remote session says when it cannot be shown (mx3-desktop-shell.md
 * §5) — the words, not the window.
 *
 * Thin-client mode is the one mode whose whole content comes from a machine
 * this process does not control, so "it did not load" is an ordinary Tuesday:
 * the server is down for an upgrade, the laptop is on a captive-portal wifi,
 * the certificate expired overnight. Left alone, Chromium answers all of those
 * with its own error page inside a frameless window — a dead end that names
 * neither the app nor the address, and on some failures with nothing but white.
 *
 * So the shell owns the failure surface. This module is the part of it that can
 * be tested without an Electron window: turning a Chromium net error, a dead
 * renderer or a refused `/healthz` probe into a headline, a sentence, and the
 * code that a bug report should carry — and assembling the query string the
 * page is loaded with.
 */

import type { ServerUrlResult } from "./server-url.js";

/** The three strings the error page renders, plus its two buttons. */
export interface RemoteFailure {
  /** One short line: what happened, in the user's terms. */
  readonly headline: string;
  /** A sentence or two: why, and what would fix it. */
  readonly detail: string;
  /** `ERR_CONNECTION_REFUSED`, `CERT_HAS_EXPIRED`, … — shown small. */
  readonly code?: string;
}

/** What `did-fail-load` and `render-process-gone` hand the shell. */
export type WindowFailure =
  | {
      readonly kind: "load";
      /** Chromium's negative net error number (`-102`, …). */
      readonly errorCode: number;
      /** Its symbolic name (`ERR_CONNECTION_REFUSED`), sometimes empty. */
      readonly errorDescription: string;
    }
  | {
      readonly kind: "render-process-gone";
      /** Electron's `details.reason`: `crashed`, `oom`, `killed`, … */
      readonly reason: string;
    };

/**
 * Chromium's code for "this navigation was replaced or cancelled" — a redirect,
 * a second `loadURL`, a window closing mid-load. It is not a failure the user
 * did anything to cause, and showing an error page for it would mean flashing
 * one during perfectly normal navigation.
 */
const ERR_ABORTED = -3;

export function isIgnorableLoadFailure(failure: WindowFailure): boolean {
  return failure.kind === "load" && failure.errorCode === ERR_ABORTED;
}

/** `ERR_CERT_*` / `ERR_SSL_*`: the class with no way past it (spec §5). */
function isCertificateError(description: string): boolean {
  return /^ERR_(CERT|SSL)_/.test(description);
}

/**
 * A Chromium load failure, in words.
 *
 * The table is short on purpose: these are the failures a self-hoster's own
 * server actually produces, and every other code falls through to a sentence
 * that still names the address and carries the code — which is what makes a
 * bug report useful without pretending to explain something we have not seen.
 */
export function describeLoadFailure(
  serverUrl: string,
  failure: Extract<WindowFailure, { kind: "load" }>,
): RemoteFailure {
  const code =
    failure.errorDescription || `net error ${String(failure.errorCode)}`;
  if (isCertificateError(failure.errorDescription)) {
    return {
      headline: "That server's certificate wasn't accepted",
      // No "continue anyway", here or anywhere: this app carries a session
      // token and every word the user says.
      detail: `${serverUrl} presented a security certificate this computer will not accept. Nothing was sent to it. Fix the certificate on the server — this app will not connect to a server it cannot verify.`,
      code,
    };
  }
  switch (failure.errorDescription) {
    case "ERR_CONNECTION_REFUSED":
      return {
        headline: "Your server didn't answer",
        detail: `Nothing is listening at ${serverUrl}. The server may be stopped, or the address may be pointing at the wrong port.`,
        code,
      };
    case "ERR_NAME_NOT_RESOLVED":
      return {
        headline: "That address couldn't be found",
        detail: `${serverUrl} could not be looked up. Check the spelling, and that this computer's network can see that name.`,
        code,
      };
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
      return {
        headline: "Your server didn't answer in time",
        detail: `${serverUrl} accepted nothing before the connection timed out. It may be overloaded, asleep, or behind something that is dropping the connection.`,
        code,
      };
    case "ERR_INTERNET_DISCONNECTED":
      return {
        headline: "This computer is offline",
        detail: `There is no network connection to reach ${serverUrl} with. Your server is fine; this machine cannot get to it.`,
        code,
      };
    case "ERR_CONNECTION_RESET":
    case "ERR_CONNECTION_CLOSED":
    case "ERR_EMPTY_RESPONSE":
      return {
        headline: "The connection was cut",
        detail: `${serverUrl} closed the connection before it answered. If it is behind a proxy, that is the first place to look.`,
        code,
      };
    default:
      return {
        headline: "Your server couldn't be loaded",
        detail: `${serverUrl} did not load. The address is stored and unchanged — nothing has been forgotten.`,
        code,
      };
  }
}

/**
 * The renderer died. Rare, and never the server's fault — but a window whose
 * content process is gone is a grey rectangle, so it gets the same page and
 * the same Retry.
 */
export function describeRenderProcessGone(
  serverUrl: string,
  failure: Extract<WindowFailure, { kind: "render-process-gone" }>,
): RemoteFailure {
  const outOfMemory = failure.reason === "oom";
  return {
    headline: outOfMemory
      ? "The window ran out of memory"
      : "The window stopped unexpectedly",
    detail: outOfMemory
      ? `The part of the app that draws ${serverUrl} was closed by the system for using too much memory. Nothing was lost on the server.`
      : `The part of the app that draws ${serverUrl} stopped. Nothing was lost on the server — it keeps your sessions whatever happens here.`,
    code: failure.reason,
  };
}

export function describeWindowFailure(
  serverUrl: string,
  failure: WindowFailure,
): RemoteFailure {
  return failure.kind === "load"
    ? describeLoadFailure(serverUrl, failure)
    : describeRenderProcessGone(serverUrl, failure);
}

/**
 * A refused `/healthz` probe, in the same shape. The probe's own message is
 * already a sentence the user can act on (server-url.ts) — all this adds is the
 * headline, chosen by what kind of refusal it was.
 */
export function describeProbeRefusal(
  refusal: Extract<ServerUrlResult, { ok: false }>,
): RemoteFailure {
  const code = refusal.code;
  switch (refusal.kind) {
    case "certificate":
      return {
        headline: "That server's certificate wasn't accepted",
        detail: refusal.message,
        code,
      };
    case "not-emberchat":
    case "unhealthy":
      return {
        headline: "That doesn't look like your server",
        detail: refusal.message,
        code,
      };
    case "address":
      return {
        headline: "That address can't be opened",
        detail: refusal.message,
        code,
      };
    default:
      return {
        headline: "Can't reach your server",
        detail: refusal.message,
        code,
      };
  }
}

export interface ErrorPageQuery {
  /** `app.getName()` — the product name is config, never a literal. */
  readonly productName: string;
  /** The address this window is supposed to be showing. */
  readonly serverUrl: string;
  readonly failure: RemoteFailure;
}

/**
 * The page's variable strings, as `loadFile` query parameters.
 *
 * Same discipline as the chooser (§4 as-built 2): what the document needs while
 * it is being built rides in the URL, and the bridge stays at the two calls the
 * page's two buttons make. None of it is a secret — it is the address the user
 * typed and the reason it did not load.
 */
export function errorPageQuery(input: ErrorPageQuery): Record<string, string> {
  const query: Record<string, string> = {
    product: input.productName,
    url: input.serverUrl,
    headline: input.failure.headline,
    detail: input.failure.detail,
  };
  if (input.failure.code !== undefined && input.failure.code !== "") {
    query.code = input.failure.code;
  }
  return query;
}
