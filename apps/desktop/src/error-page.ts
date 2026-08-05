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
      detail: `This computer wouldn't accept the security certificate at ${serverUrl}, so nothing was sent to it. The certificate needs fixing on the server — this app will not connect to a server it can't check.`,
      code,
    };
  }
  switch (failure.errorDescription) {
    case "ERR_CONNECTION_REFUSED":
      return {
        headline: "Your server didn't answer",
        detail: `Nothing answered at ${serverUrl}. Your server may be switched off, or the address may be pointing at the wrong port.`,
        code,
      };
    case "ERR_NAME_NOT_RESOLVED":
      return {
        headline: "That address couldn't be found",
        detail: `This computer couldn't find ${serverUrl} on the network. Check the spelling, and that this computer is able to reach that name.`,
        code,
      };
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
      return {
        headline: "Your server didn't answer in time",
        detail: `${serverUrl} took too long to answer. It may be busy, asleep, or behind something that's dropping the connection.`,
        code,
      };
    case "ERR_INTERNET_DISCONNECTED":
      return {
        headline: "This computer is offline",
        detail: `There's no network connection here to reach ${serverUrl} with. Your server is probably fine — this computer just can't get to it.`,
        code,
      };
    case "ERR_CONNECTION_RESET":
    case "ERR_CONNECTION_CLOSED":
    case "ERR_EMPTY_RESPONSE":
      return {
        headline: "The connection was cut",
        detail: `${serverUrl} hung up before it answered. If your server sits behind a proxy, that's the first place to look.`,
        code,
      };
    default:
      return {
        headline: "Your server didn't load",
        detail: `${serverUrl} didn't load. The address is saved and unchanged — nothing has been forgotten.`,
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
      ? "This window ran out of memory"
      : "This window stopped unexpectedly",
    detail: outOfMemory
      ? `The part of the app showing ${serverUrl} used too much memory, so this computer closed it. Nothing was lost — your conversations are safe on your server.`
      : `The part of the app showing ${serverUrl} stopped. Nothing was lost — your server keeps you connected whatever happens here.`,
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
