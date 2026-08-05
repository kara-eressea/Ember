/**
 * The address of somebody's own EmberChat server, as typed into the chooser
 * (mx3-desktop-shell.md §4/§5) — normalized, then proved to answer.
 *
 * Two halves, deliberately separate:
 *
 * - `normalizeServerUrl` is pure text work: what the user typed, turned into
 *   the one canonical spelling that gets stored in `config.json` and later
 *   handed to `loadURL`. It is also the validator the stored value is re-run
 *   through on read, so a hand-edited config file cannot point the window at
 *   `file:///` or anything else that is not a web origin.
 * - `probeServerUrl` is the network half: `GET <url>/healthz`, the same
 *   readiness contract the container image's smoke test and the embedded
 *   server's boot both use. It lives in the MAIN process on purpose — the
 *   chooser page is a `file://` document with a strict CSP, and a renderer
 *   fetch would be answering a different question (CORS) than the one asked.
 *
 * Both return a result object rather than throwing: every failure here is a
 * sentence the user reads inside the chooser window, so the message is the
 * point, not an exception's stack.
 */

/** `GET /healthz` on a healthy instance answers exactly this (apps/server). */
const HEALTHZ_BODY_STATUS = "ok";

/** Long enough for a sleepy VPS, short enough that a typo is not a hang. */
const PROBE_TIMEOUT_MS = 6_000;

/**
 * Why an address was refused — the message is what the user reads, this is what
 * the shell branches on. #302's error page picks its headline from it, and
 * `certificate` is the one that must never grow a way past it (spec §5).
 */
export type RefusalKind =
  /** The text is not an address this app can open. */
  | "address"
  /** Nothing answered: down, wrong port, no route, offline. */
  | "unreachable"
  /** TLS said no. Fatal by design — there is no "proceed anyway" anywhere. */
  | "certificate"
  /** Something answered, with an error status. */
  | "unhealthy"
  /** Something answered 200, but not the `/healthz` contract. */
  | "not-emberchat";

export type ServerUrlResult =
  | { readonly ok: true; readonly url: string }
  | {
      readonly ok: false;
      readonly kind: RefusalKind;
      readonly message: string;
      /**
       * The machine's word for it, when there is one: `ERR_CERT_DATE_INVALID`,
       * `502`. The message is what a person reads; this is what they copy into
       * a bug report, and what the shell's error page shows on its own row.
       */
      readonly code?: string;
    };

/**
 * Hosts where plain `http://` is honest rather than a downgrade: the traffic
 * never leaves the machine. Everything else must be `https://` — this app
 * carries a session token and every word the user says.
 *
 * Literal spellings only, never a resolved lookup: a name that *resolves* to
 * 127.0.0.1 today is still a name somebody else's DNS controls tomorrow.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `https://host:port/base` — no trailing slash, no query, no fragment. */
export function normalizeServerUrl(raw: string): ServerUrlResult {
  const typed = raw.trim();
  if (typed === "") {
    return refuse(
      "address",
      "Enter your server's address — for example https://chat.example.com",
    );
  }

  // A bare `chat.example.com` or `chat.example.com:8443` is what people type,
  // and https is the assumption to make on their behalf. The scheme test
  // insists on the `//` so that `example.com:8443` is read as a port and not
  // as a scheme called `example.com` (which is how `new URL` reads it).
  const typedScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);

  let url: URL;
  try {
    url = new URL(typedScheme ? typed : `https://${typed}`);
  } catch {
    return refuse("address", `"${typed}" is not an address this app can open.`);
  }

  // …except for loopback, where it is the wrong assumption: a server on this
  // machine is being reached over a socket that never leaves it, and almost
  // nobody puts a certificate on one. Typing `localhost:3000` should mean the
  // thing that is actually listening there, not an https refusal.
  if (!typedScheme && LOOPBACK_HOSTS.has(url.hostname)) {
    url.protocol = "http:";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return refuse("address", "A server address has to start with https://");
  }
  if (url.hostname === "") {
    return refuse("address", `"${typed}" is missing a server name.`);
  }
  if (url.username !== "" || url.password !== "") {
    return refuse(
      "address",
      "Leave the username and password out of the address — you sign in inside the app.",
    );
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return refuse(
      "address",
      "Only https:// addresses are accepted (http:// is allowed for localhost). Without it, everything you send crosses the network in the clear.",
    );
  }

  // Query and fragment are dropped rather than refused: they are meaningless
  // on a base origin, and pasting a link from a browser's address bar is the
  // most likely way one arrives. A path is kept — a server reverse-proxied
  // under `/chat` is a real deployment.
  const path = url.pathname.replace(/\/+$/, "");
  return { ok: true, url: `${url.protocol}//${url.host}${path}` };
}

/** The liveness endpoint for a normalized base URL. */
export function healthzUrl(serverUrl: string): string {
  return `${serverUrl}/healthz`;
}

export interface ProbeOptions {
  /** Injectable for tests; defaults to the main process's global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/**
 * Asks the address whether it is an EmberChat server, and reports the answer
 * in words the user can act on.
 *
 * A 200 is not enough on its own: a parked domain, a router's login page or a
 * static host that serves `index.html` for every path all answer 200. The body
 * has to be the `/healthz` contract, which is what makes "this is the wrong
 * address" distinguishable from "your server is down".
 */
export async function probeServerUrl(
  serverUrl: string,
  options: ProbeOptions = {},
): Promise<ServerUrlResult> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  let response: Response;
  try {
    response = await doFetch(healthzUrl(serverUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { accept: "application/json" },
    });
  } catch (error) {
    // One class of failure does get the underlying error's word for it: a
    // certificate this machine will not accept is a *specific* thing to fix on
    // the server, and "could not reach it" would send the user looking at the
    // wrong end. Everything else stays a sentence — "fetch failed" and
    // "ENOTFOUND" are not ones, and the causes the user can do something about
    // are the same three either way.
    const certificate = certificateProblem(error);
    if (certificate !== undefined) {
      return refuse(
        "certificate",
        certificateRefusal(serverUrl, certificate),
        certificate,
      );
    }
    return refuse(
      "unreachable",
      `Could not reach ${serverUrl}. Check the address, that the server is running, and that this computer can get to it.`,
    );
  }

  if (!response.ok) {
    return refuse(
      "unhealthy",
      `${serverUrl} answered with ${String(response.status)}. That is not an EmberChat server, or it is not healthy right now.`,
      String(response.status),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { status?: unknown }).status !== HEALTHZ_BODY_STATUS
  ) {
    return refuse(
      "not-emberchat",
      `Something answered at ${serverUrl}, but it does not look like an EmberChat server.`,
    );
  }

  return { ok: true, url: serverUrl };
}

/**
 * Codes that mean "TLS refused this connection", from the two stacks that can
 * produce them: OpenSSL's (`DEPTH_ZERO_SELF_SIGNED_CERT`,
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`, `ERR_TLS_*` — what
 * Node's own fetch reports) and Chromium's (`net::ERR_CERT_*`, `ERR_SSL_*` —
 * what `net.fetch` and the window itself report). The shell uses the second in
 * production so the probe trusts exactly what the window will trust; the first
 * is what tests and a plain-Node caller see.
 */
const CERTIFICATE_CODE =
  /(^|_)(CERT|SSL|TLS)(_|$)|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)_|HOSTNAME_MISMATCH/;

/**
 * The certificate code inside a failed fetch, if that is what failed it.
 *
 * Both stacks bury it: undici throws `TypeError: fetch failed` with the real
 * error as `cause`, and Chromium puts `net::ERR_CERT_…` in the message. So this
 * walks the cause chain looking at both `code` and `message`.
 */
export function certificateProblem(error: unknown): string | undefined {
  for (
    let step: unknown = error, depth = 0;
    step !== undefined && step !== null && depth < 5;
    depth++
  ) {
    const { code, message, cause } = step as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof code === "string" && CERTIFICATE_CODE.test(code)) {
      return code;
    }
    if (typeof message === "string") {
      const found = /\b(?:net::)?((?:ERR_)?[A-Z][A-Z0-9_]*)/g;
      for (const [, token] of message.matchAll(found)) {
        if (token !== undefined && CERTIFICATE_CODE.test(token)) {
          return token;
        }
      }
    }
    step = cause;
  }
  return undefined;
}

/**
 * The one refusal with no way past it (spec §5, invariant: no
 * `certificate-error` handler, no `setCertificateVerifyProc`). It names the
 * code, says where the fix is, and offers nothing to click — a "connect
 * anyway" button on a client that carries a session token and every word the
 * user says would undo the reason https is required in the first place.
 */
function certificateRefusal(serverUrl: string, code: string): string {
  return `${serverUrl} presented a security certificate this computer will not accept (${code}). Nothing was sent to it. Fix the certificate on the server — this app will not connect to a server it cannot verify.`;
}

function refuse(
  kind: RefusalKind,
  message: string,
  code?: string,
): ServerUrlResult {
  return { ok: false, kind, message, ...(code === undefined ? {} : { code }) };
}
