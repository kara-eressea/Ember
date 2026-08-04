// Recovering a dead gateway from the phone tier's conversation pane (MP3 §5,
// #377). Runs in the `mobile-chromium` project — a Pixel-class device context
// that never resizes — because the whole point is the pane the phone stack
// hides the sidebar behind.
//
// The gap this guards: the "not connected, tap to retry" chip has lived in the
// sidebar head since #465, and `data-pane="conversation"` hides the sidebar
// outright. Installed to a home screen there is no address bar behind it
// either, so before this the app's one recovery sat on the one screen a user
// reading a conversation is not looking at.
//
// The freezing half of §5 is not here and cannot be: `freeze`/`resume` are
// dispatched by the browser's own tab-lifecycle machinery, which neither a
// page nor CDP can ask to run, and a bfcache restore needs a cross-document
// navigation Playwright will not reliably keep in the cache. Both are covered
// where they can be — gateway/socket.test.ts, on fake timers.
//
// Owns thawcaldwell@example.test (Thaw Caldwell) and the Thaw Room: spec files
// run in parallel and a character holds one sim connection, so specs share
// neither.

import type { Locator, Page } from "@playwright/test";
import {
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  test,
} from "./helpers.js";
import {
  measureTargets,
  settleAnimations,
  TARGET_MIN_PX,
} from "./touch-targets.js";

const ROOM = "ADH-377lifecycle4b7c2e19";
const ROOM_TITLE = "Thaw Room";
const CHIP = "Reconnect now";
const OVERFLOW = "More conversation actions";

/** The conversation toolbar — no test id of its own, and none is worth adding:
 * the ⋯ chip lives in exactly one row (mobile-shell.spec.ts says the same). */
function toolbar(page: Page): Locator {
  return page
    .locator("header")
    .filter({ has: page.getByRole("button", { name: OVERFLOW }) });
}

function sidebar(page: Page): Locator {
  return page
    .getByRole("navigation")
    .filter({ has: page.getByLabel("Find in the channel list") });
}

test("the phone stack can reconnect from either pane (#377)", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await interceptAvatars(page);

  // Proxy the gateway so the spec can sever it *and keep it severed*: with
  // `refusing` set, every attempt is closed before it reaches the bouncer,
  // which is what a phone that came back on a dead radio looks like. Nothing
  // downstream is stubbed — the backoff, the chip and the recovery are the
  // real client.
  let refusing = false;
  let sever: (() => Promise<void>) | undefined;
  await page.routeWebSocket(/\/gateway/, (ws) => {
    if (refusing) {
      void ws.close({ code: 1006, reason: "network gone" });
      return;
    }
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(message);
    });
    sever = () => ws.close({ code: 1006, reason: "network gone" });
  });

  await provisionAndConnect(page, "thawcaldwell@example.test", "Thaw Caldwell");
  await joinChannel(page, ROOM, ROOM_TITLE);

  const shell = page.getByTestId("app-shell");
  const back = page.getByRole("link", { name: "Back to conversations" });
  // Joining opens the room, and on a phone that *is* the conversation pane.
  await expect(shell).toHaveAttribute("data-pane", "conversation");
  await expect(sidebar(page)).toBeHidden();

  // ── The socket dies under a conversation ────────────────────────────────
  refusing = true;
  await sever!();

  const toolbarChip = toolbar(page).getByRole("button", { name: CHIP });
  await expect(toolbarChip).toBeVisible({ timeout: 30_000 });
  // The pane really is still the conversation — this is the toolbar's own
  // copy, not the sidebar reappearing.
  await expect(shell).toHaveAttribute("data-pane", "conversation");
  await expect(sidebar(page)).toBeHidden();

  // ── …and it is a thumb-sized target, not a 20px pill ────────────────────
  await settleAnimations(page);
  const { targets, overlaps } = await measureTargets(
    page,
    "conversation toolbar",
    toolbar(page),
  );
  const measured = targets.filter((target) => target.label === CHIP);
  expect(measured).toHaveLength(1);
  expect(measured[0]?.ownH ?? 0).toBeGreaterThanOrEqual(TARGET_MIN_PX);
  expect(measured[0]?.ownW ?? 0).toBeGreaterThanOrEqual(TARGET_MIN_PX);
  // MP2 §3's other half: a hit area may not reach into its neighbour's. The
  // back chip is four pixels away and wears a 44px overlay of its own, which
  // is what the extra gap on the phone tier is for.
  expect(overlaps.filter((pair) => pair.a === CHIP || pair.b === CHIP)).toEqual(
    [],
  );

  // ── The list pane keeps saying it too ───────────────────────────────────
  await back.click();
  await expect(shell).toHaveAttribute("data-pane", "list");
  await expect(sidebar(page).getByRole("button", { name: CHIP })).toBeVisible();

  // ── Back in the conversation, the chip is what puts it right ────────────
  await sidebar(page)
    .getByRole("link", { name: new RegExp(ROOM_TITLE) })
    .click();
  await expect(shell).toHaveAttribute("data-pane", "conversation");
  await expect(toolbarChip).toBeVisible();

  refusing = false;
  await toolbarChip.click();
  // reconnectNow skips the backoff outright, so this is quick — quicker than
  // the ladder the client was parked on had any intention of being.
  await expect(toolbarChip).toHaveCount(0, { timeout: 20_000 });

  // Really back, not merely painted back: a line round-trips through the new
  // socket to the bouncer and its F-Chat session.
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("thawed out");
  await composer.press("Enter");
  await expect(
    page.getByTestId("message-log").getByText("thawed out"),
  ).toBeVisible({ timeout: 15_000 });
});
