// Smoke test against a running EmberChat instance pointed at fchat-sim
// (M1 step 11: "docker compose up → usable app against sim"). Walks the full
// slice over the public surface: statics with injected config, register,
// F-List account vaulting (ticket flow server↔sim), identity creation, and a
// gateway session that actually reaches "online".
//
//   node scripts/smoke.mjs http://127.0.0.1:3900

const base = process.argv[2] ?? "http://127.0.0.1:3000";
const unique = String(Date.now());

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

// ── Statics + runtime config injection ───────────────────────────────────────
{
  const health = await fetch(`${base}/healthz`);
  if (!health.ok) fail("healthz", String(health.status));
  ok("healthz");

  const index = await fetch(`${base}/app/deep/link`);
  const html = await index.text();
  if (!index.ok || !html.includes("window.__CONFIG__")) {
    fail(
      "spa",
      "index.html with injected __CONFIG__ not served for a client route",
    );
  }
  ok("spa fallback + injected runtime config");
}

// ── App account ──────────────────────────────────────────────────────────────
const session = await json("register", "/api/auth/register", {
  method: "POST",
  body: {
    email: `smoke-${unique}@example.test`,
    username: `smoke${unique}`,
    password: "correct-horse-battery",
  },
});
ok("register");
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
