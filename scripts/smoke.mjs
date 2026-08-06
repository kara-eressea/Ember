// Smoke test against a running EmberChat instance pointed at fchat-sim
// (M1 step 11: "docker compose up → usable app against sim"). Walks the full
// slice over the public surface: statics, sign-in,
// F-List account vaulting (ticket flow server↔sim), identity creation, and a
// gateway session that actually reaches "online".
//
//   node scripts/smoke.mjs http://127.0.0.1:3900 you@example.test your-password
//
// The account is not created here: instances are admin-only since M7, so
// scripts/smoke.sh makes it with the admin CLI in the container first and
// passes the credentials in. Signing in is what a user does anyway.

const base = process.argv[2] ?? "http://127.0.0.1:3000";
const email = process.argv[3] ?? "smoke@example.test";
const password = process.argv[4] ?? "correct-horse-battery";

function fail(step, detail) {
  console.error(`✗ ${step}: ${detail}`);
  process.exit(1);
}

function ok(step) {
  console.log(`✓ ${step}`);
}

async function json(step, path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    fail(
      step,
      `${method} ${path} → ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
}

// ── Statics ──────────────────────────────────────────────────────────────────
{
  const health = await fetch(`${base}/healthz`);
  if (!health.ok) fail("healthz", String(health.status));
  ok("healthz");

  // The document is Vite's own since #556 — nothing is injected into it — so
  // the check is that a client route gets the app's index.html at all. The
  // title is spelled out because this script runs outside the workspace
  // (against a container) and cannot import APP_NAME; it is the same string.
  const index = await fetch(`${base}/app/deep/link`);
  const html = await index.text();
  if (!index.ok || !html.includes("<title>EmberChat</title>")) {
    fail("spa", "index.html not served for a client route");
  }
  ok("spa fallback");
}

// ── App account ──────────────────────────────────────────────────────────────
const session = await json("sign in", "/api/auth/login", {
  method: "POST",
  body: { email, password, deviceLabel: "smoke test" },
});
ok("sign in");
const token = session.accessToken;

// ── F-List account (ticket fetch server → sim) + identity ────────────────────
const { account } = await json("add flist account", "/api/flist-accounts", {
  method: "POST",
  body: { accountName: "amber@example.test", password: "hunter2" },
  token,
});
ok("flist account vaulted (ticket verified against sim)");

const { characters } = await json(
  "character list",
  `/api/flist-accounts/${account.id}/characters`,
  { token },
);
if (!characters.includes("Amber Vale")) {
  fail("character list", `unexpected characters: ${characters.join(", ")}`);
}
ok("character list");

const { identity } = await json("create identity", "/api/identities", {
  method: "POST",
  body: { flistAccountId: account.id, characterName: "Amber Vale" },
  token,
});
ok("identity created");

// ── Gateway: hello → ready → session.connect → online ────────────────────────
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error("gateway session never reached online"));
  }, 30_000);
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/gateway`);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ t: "hello", d: { token, protocolVersion: 1 } }));
  });
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.t === "ready") {
      ws.send(JSON.stringify({ t: "sub", d: { identityId: identity.id } }));
      ws.send(
        JSON.stringify({
          t: "cmd",
          id: 1,
          d: { identityId: identity.id, action: "session.connect" },
        }),
      );
    }
    if (frame.t === "ack" && !frame.d.ok) {
      reject(new Error(`session.connect refused: ${frame.d.error}`));
    }
    if (
      frame.t === "event" &&
      frame.d.kind === "session.status" &&
      frame.d.d.status === "online"
    ) {
      clearTimeout(timer);
      ws.close();
      resolve();
    }
  });
  ws.addEventListener("error", () => {
    reject(new Error("gateway socket error"));
  });
}).catch((error) => {
  fail("gateway", error.message);
});
ok("gateway session online against sim");

console.log("smoke: all green");
