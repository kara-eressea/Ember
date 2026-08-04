// "Mark as read" from the sidebar context menus (#315): a backlog can be
// cleared without opening the conversation. The sidebar right-click menus gain
// a Mark as read item that clears the unread badge and advances the persisted
// read cursor — so it does not navigate and it sticks across a reattach.
//
// Second test, same theme from the other side (#515): reading a conversation
// clears its badge WITHOUT moving its row, because the people sections sort on
// recent activity rather than floating unread rows. Owns bracken@example.test
// (Bracken Vale), cress@example.test (Cress Dell), wisp@example.test (Wisp
// Harrow) and quillsable@example.test (Alder Quill, Wren Sable): specs never
// share an account or a character (world.ts).

import {
  delay,
  expect,
  interceptAvatars,
  provisionAndConnect,
  SimClient,
  test,
} from "./helpers.js";

test("mark a DM read from its row menu — badge clears, no navigation, survives reattach", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "bracken@example.test", "Bracken Vale");

  const cress = await SimClient.connect(
    "cress@example.test",
    "hunter2",
    "Cress Dell",
  );
  try {
    // An unread DM lands in the sidebar; the conversation is never opened.
    cress.send("PRI", { recipient: "Bracken Vale", message: "psst, awake?" });
    const nav = page.getByRole("navigation");
    const dmRow = nav.getByRole("link", { name: /Cress Dell/ });
    await expect(dmRow.getByTestId("nav-badge")).toBeVisible({
      timeout: 15_000,
    });

    // Right-click the row and mark it read: the badge clears and the route
    // must not change to the conversation.
    const urlBefore = page.url();
    await dmRow.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Cress Dell menu" });
    await menu.getByRole("menuitem", { name: "Mark as read" }).click();

    await expect(dmRow.getByTestId("nav-badge")).toHaveCount(0);
    expect(page.url()).toBe(urlBefore);

    // It sticks: a full detach + reattach shows no backlog badge — the read
    // cursor advanced server-side, not just the local badge.
    await page.goto("/identities");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await expect(page).toHaveURL(/\/app\//);
    await expect(
      nav.getByRole("link", { name: /Cress Dell/ }).getByTestId("nav-badge"),
    ).toHaveCount(0);
  } finally {
    cress.close();
  }
});

test("reading a DM clears its badge without reordering the section (#515)", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await interceptAvatars(page);

  await provisionAndConnect(page, "wisp@example.test", "Wisp Harrow");

  const alder = await SimClient.connect(
    "quillsable@example.test",
    "hunter2",
    "Alder Quill",
  );
  const wren = await SimClient.connect(
    "quillsable@example.test",
    "hunter2",
    "Wren Sable",
  );
  const nav = page.getByRole("navigation");
  /** The two DM rows, top to bottom. */
  const dmOrder = async () =>
    (await nav.getByRole("link").allTextContents())
      .map((text) =>
        text.includes("Alder Quill")
          ? "Alder Quill"
          : text.includes("Wren Sable")
            ? "Wren Sable"
            : undefined,
      )
      .filter((name) => name !== undefined);

  try {
    // Alder writes first, Wren second — so activity order is the reverse of
    // the alphabet, and the two can be told apart.
    alder.send("PRI", { recipient: "Wisp Harrow", message: "morning" });
    await expect(nav.getByRole("link", { name: /Alder Quill/ })).toBeVisible({
      timeout: 15_000,
    });
    await delay(200);
    wren.send("PRI", { recipient: "Wisp Harrow", message: "you around?" });
    const wrenRow = nav.getByRole("link", { name: /Wren Sable/ });
    await expect(wrenRow.getByTestId("nav-badge")).toBeVisible({
      timeout: 15_000,
    });
    await expect.poll(dmOrder).toEqual(["Wren Sable", "Alder Quill"]);

    // Read Wren's conversation. The badge clears — and the row stays exactly
    // where it was, which is the whole point of #515: before it, reading
    // dropped the row back to its alphabetical seat (below Alder) while the
    // user was still mid-conversation.
    await wrenRow.click();
    await expect(
      page.getByTestId("message-log").getByText("you around?"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(wrenRow.getByTestId("nav-badge")).toHaveCount(0);
    await expect.poll(dmOrder).toEqual(["Wren Sable", "Alder Quill"]);
  } finally {
    alder.close();
    wren.close();
  }
});
