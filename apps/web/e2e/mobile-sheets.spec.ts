// Every surface that claims a long press opens its sheet (MP2 §1, #376).
//
// The gap this closes is a wiring gap, not a behaviour one. `useLongPress` and
// `MenuSurface` are covered thoroughly by unit and component tests, and
// mobile-longpress.spec.ts walks one claimed surface end to end — but the hook
// is spread onto *ten* elements across five files, and a row that forgets
// `{...press}` fails silently: it keeps its `onContextMenu`, so every desktop
// test and every unit test still passes, and the menu is simply unreachable on
// an iPhone. That is exactly the bug MP2 §1 exists to fix, re-introduced one
// surface at a time.
//
// So this file is a census, not an investigation: one hold on each claimed
// element class, asserting the menu that opens is the sheet the tier calls for.
// What a sheet *is* — its geometry, its items, its dismissals, its actions —
// belongs to mobile-longpress.spec.ts and is not repeated here.
//
// Two of the presses double as claims of their own, because the surfaces they
// sit on have a competing gesture. A picker tile's own click inserts the eicon
// and a member row's opens the mini profile card, so on those two the hold has
// to open a menu *and* leave the compatibility click on the floor — the
// ghost-click swallow, on a real engine rather than in jsdom.
//
// Not in the `mobile-webkit` project (MP4, #378): the census is ten holds and
// nothing else, and a hold is `Input.dispatchTouchEvent`, which is Chromium's
// alone. The scope-out is in playwright.config.ts (WEBKIT_UNREACHABLE). It
// costs less than it looks: what this file checks is *wiring* — whether each
// row spreads `{...press}` — which is the same JSX on every engine. The
// engine-dependent half (the ghost click's timing, iOS's callout) was never
// reachable from a desktop WebKit build either, and is in mp2-touch.md §6.
//
// Owns knuckle@example.test (Knuckle Reed), palmwex@example.test (Palm
// Wexford) and the Knuckle Room: spec files run in parallel and a character
// holds one sim connection, so specs share neither (world.ts).

import type { CDPSession, Locator, Page } from "@playwright/test";
import {
  delay,
  expect,
  interceptAvatars,
  joinChannel,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";
import { longPress } from "./long-press.js";

const ROOM = "ADH-376sheets5a6b7c8d";
const ROOM_TITLE = "Knuckle Room";
const CHARACTER = "Knuckle Reed";
const PARTNER = "Palm Wexford";
const EICON = "tearsofjoy";

/**
 * The sheet named `label` is open, in the phone shape.
 *
 * The shape check is what makes this a claim about the tier rather than about
 * the menu: an anchored popover carries `role="menu"` and floats at the press
 * point, the sheet is a modal dialog spanning the width at the bottom edge.
 * One assertion, so a surface that somehow opened the desktop shape on a phone
 * is a failure here rather than a pass.
 */
async function expectSheet(page: Page, label: string): Promise<void> {
  const sheet = page.getByRole("dialog", { name: label });
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  const box = await sheet.boundingBox();
  const viewport = page.viewportSize();
  expect(box?.width).toBeCloseTo(viewport?.width ?? 0, 0);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(
    viewport?.height ?? 0,
    0,
  );
  // A sheet with no items would satisfy everything above and be useless. The
  // role prefix rather than `getByRole("menuitem")`: the section menu's one
  // item is a `menuitemcheckbox`, and menu-surface.module.css sizes the sheet's
  // rows off the same prefix for the same reason.
  expect(await sheet.locator('[role^="menuitem"]').count()).toBeGreaterThan(0);
}

/**
 * Put the open sheet away, and wait until it is gone — the next press has to
 * land on the surface underneath, not on a backdrop still fading out.
 *
 * The sheet's own ✕ rather than Escape, because a phone has no Escape key and
 * this file is about what a phone can do. It is also the only dismissal that
 * is one gesture from every state: the member menu's Escape closes one *level*
 * at a time, and a sheet raised from a DM row arrives with the "Invite to"
 * submenu already expanded — the engine's compatibility `mouseenter` lands on
 * it as the sheet rises under the finger, and nothing on a touchscreen ever
 * sends the `mouseleave` that would close it again.
 */
async function dismiss(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: `Close ${label}` }).tap();
  await expect(page.getByRole("dialog", { name: label })).toHaveCount(0);
}

/** Hold, assert the sheet, put it away. The whole census in one line each. */
async function pressOpensSheet(
  cdp: CDPSession,
  page: Page,
  target: Locator,
  label: string,
): Promise<void> {
  await longPress(cdp, page, target);
  await expectSheet(page, label);
  await dismiss(page, label);
}

test("phone device: every surface that claims a long press opens its sheet (#376)", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "knuckle@example.test", CHARACTER);
  const cdp = await page.context().newCDPSession(page);

  const partner = await SimClient.connect(
    "palmwex@example.test",
    "hunter2",
    PARTNER,
  );
  try {
    await joinChannel(page, ROOM, ROOM_TITLE);
    partner.send("JCH", { channel: ROOM });
    await delay(400);
    // One line in the room, carrying the eicon the picker is seeded from…
    partner.send("MSG", {
      channel: ROOM,
      message: `Knock knock [eicon]${EICON}[/eicon]`,
    });
    // …and a DM, so the sidebar has a person row as well as a channel one.
    partner.send("PRI", { recipient: CHARACTER, message: "And a word aside." });
    await delay(400);

    await expect(page.locator("html")).toHaveAttribute("data-layout", "phone");
    const shell = page.getByTestId("app-shell");
    await expect(shell).toHaveAttribute("data-pane", "conversation");

    // ── The member overlay's rows (MemberList.MemberRow) ──────────────────
    // Reached the way a phone reaches it: the member-list chip lives in the ⋯
    // menu on this tier (MP1 §3), and the list itself is a full-height
    // overlay (MP1 package D).
    await page.getByRole("button", { name: "More conversation actions" }).tap();
    const overflow = page.getByRole("dialog", {
      name: "More conversation actions",
    });
    await expect(overflow).toBeVisible();
    await overflow.getByRole("button", { name: "Toggle member list" }).tap();
    const members = page.getByRole("dialog", { name: "Members" });
    await expect(members).toBeVisible();
    const memberRow = members
      .getByRole("listitem")
      .filter({ hasText: PARTNER });
    await expect(memberRow).toBeVisible({ timeout: 15_000 });

    await longPress(cdp, page, memberRow);
    await expectSheet(page, `${PARTNER} menu`);
    // The row's own click opens the mini profile card. The hold must not also
    // do that — the compatibility click the engine synthesizes after the lift
    // is the one this surface would visibly lose to.
    await expect(
      page.getByRole("dialog", { name: `Profile card: ${PARTNER}` }),
    ).toHaveCount(0);
    await dismiss(page, `${PARTNER} menu`);
    await page.keyboard.press("Escape");
    await expect(members).toHaveCount(0);

    // ── An eicon picker tile (EiconPicker.Tile) ──────────────────────────
    // Favourite the eicon from the log first, so the picker's default tab has
    // a tile in it without reaching for the index-backed tabs (which are
    // pref-gated, and whose toggle is not what this file is about).
    const log = page.getByTestId("message-log");
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    const eicon = log.getByRole("img", { name: EICON });
    await expect(eicon).toBeVisible({ timeout: 15_000 });

    // Focus the composer first, because a sheet raised while the soft keyboard
    // is up depends on what happens next. The sheet is `position: fixed;
    // bottom: 0` — pinned to the LAYOUT viewport, which a keyboard does not
    // shrink on iOS or Chrome Android (visual-viewport.ts), and it does not
    // read `--eb-keyboard-inset`. Measured under package B's shim it sits
    // entirely behind the keyboard line. What saves it on a real device is
    // that it is modal: opening it takes focus off the field, and a blurred
    // field is what retracts the keyboard. So the load-bearing claim is this
    // one, and it is the guard that will notice if the trap ever goes away.
    await composer.click();
    await expect(composer).toBeFocused();
    await longPress(cdp, page, eicon);
    const eiconSheet = page.getByRole("dialog", {
      name: `${EICON} eicon menu`,
    });
    await expect(eiconSheet).toBeVisible();
    await expect(composer).not.toBeFocused();
    await eiconSheet.getByRole("menuitem", { name: "Favourite" }).tap();
    await expect(eiconSheet).toHaveCount(0);

    await page.getByRole("button", { name: "Eicon", exact: true }).tap();
    const picker = page.getByRole("dialog", { name: "Eicon picker" });
    await expect(picker).toBeVisible();
    const tile = picker.getByRole("button", { name: `Insert ${EICON}` });
    await expect(tile).toBeVisible({ timeout: 15_000 });

    await longPress(cdp, page, tile);
    await expectSheet(page, `${EICON} eicon menu`);
    // Same claim as the member row, and the louder of the two: a tile's click
    // inserts the eicon, so a ghost click that got through would leave
    // `[eicon]…[/eicon]` in the composer behind the sheet.
    await expect(composer).toHaveValue("");
    await dismiss(page, `${EICON} eicon menu`);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    // ── …and what is deliberately NOT claimed (§7) ───────────────────────
    // The prose exemption, read off the rendered document rather than off the
    // stylesheet: a message's words are selectable on every device, and the
    // whole enforcement is that no element from the text up to the log carries
    // `data-eb-press` — which is what `base.css` scopes the callout and
    // selection suppression to. A claim spreading up one container would take
    // text selection off the log with it, and nothing else would notice.
    const prose = await log
      .getByText("Knock knock", { exact: false })
      .evaluate((el) => {
        const chain: { pressed: boolean; select: string }[] = [];
        for (
          let node: HTMLElement | null = el as HTMLElement;
          node && node.dataset["testid"] !== "message-log";
          node = node.parentElement
        ) {
          chain.push({
            pressed: node.hasAttribute("data-eb-press"),
            select: getComputedStyle(node).userSelect,
          });
        }
        return chain;
      });
    expect(prose.some((node) => node.pressed)).toBe(false);
    expect(prose.every((node) => node.select !== "none")).toBe(true);

    // ── The list pane: sidebar rows, section headers, the folded rail ─────
    await page.getByRole("link", { name: "Back to conversations" }).tap();
    await expect(shell).toHaveAttribute("data-pane", "list");

    const sidebar = page
      .getByRole("navigation")
      .filter({ has: page.getByLabel("Filter the channel list") });

    // A channel row (Sidebar.NavRow → ChannelContextMenu).
    await pressOpensSheet(
      cdp,
      page,
      sidebar.getByRole("link", { name: ROOM_TITLE }),
      `${ROOM_TITLE} menu`,
    );

    // A DM row — the same NavRow component, a different menu behind it
    // (MemberContextMenu), and the row a reader is likeliest to hold.
    await pressOpensSheet(
      cdp,
      page,
      sidebar.getByRole("link", { name: new RegExp(PARTNER) }),
      `${PARTNER} menu`,
    );

    // A people-section header (Sidebar.SectionHeader → SectionOfflineMenu).
    // The only route to the per-section "Show offline" toggle there is: no
    // chip, no menu item anywhere else (#329).
    // The press is on the header row, not on its collapse toggle — hence the
    // step up out of the button that names it.
    await pressOpensSheet(
      cdp,
      page,
      sidebar
        .getByRole("button", { name: "Direct messages" })
        .locator("xpath=.."),
      "Direct messages section menu",
    );

    // An identity-rail item (IdentityRail.RailItem), which on this tier is a
    // strip inside the list pane's header rather than a column of its own.
    await pressOpensSheet(
      cdp,
      page,
      page.getByTestId("rail-item"),
      `${CHARACTER} menu`,
    );
  } finally {
    partner.close();
  }
});
