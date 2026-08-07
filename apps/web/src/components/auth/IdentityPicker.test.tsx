// @vitest-environment jsdom
//
// The picker must not offer actions before its first load resolves. A click
// on "Add a server identity" inside that window mounted AddIdentityFlow with
// accounts=[], whose mode useState snapshots "brand-new account" and never
// reconciles — an existing account's second identity dead-ended in the wrong
// form and the rail E2E hung its whole budget on the character list (E2E
// hang diagnosis, 2026-08-02; CI-trace-verified).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdentityPicker } from "./IdentityPicker.js";

const listIdentities = vi.hoisted(() => vi.fn());
const listFlistAccounts = vi.hoisted(() => vi.fn());
const listCharacters = vi.hoisted(() => vi.fn());
const addFlistAccount = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api.js", () => ({
  ApiError: class ApiError extends Error {},
  api: { listIdentities, listFlistAccounts, listCharacters, addFlistAccount },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const ACCOUNT = {
  id: "acc-1",
  accountName: "rowan@example.test",
  unlocked: true,
  remembered: false,
  createdAt: "2026-08-02T00:00:00Z",
};

const IDENTITY = {
  id: "ident-1",
  flistAccountId: "acc-1",
  characterName: "Rowan Redleaf",
  autoConnect: true,
  sortOrder: 0,
  createdAt: "2026-08-02T00:00:00Z",
  sessionStatus: "online",
};

function renderPicker() {
  return render(
    <MemoryRouter>
      <IdentityPicker />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("IdentityPicker first-load gate", () => {
  it("offers no actions until identities AND accounts have loaded", async () => {
    const identitiesLoad = deferred<{ identities: (typeof IDENTITY)[] }>();
    const accountsLoad = deferred<{
      accounts: (typeof ACCOUNT)[];
      canRemember: boolean;
    }>();
    listIdentities.mockReturnValue(identitiesLoad.promise);
    listFlistAccounts.mockReturnValue(accountsLoad.promise);
    renderPicker();

    // While loading: no add button to race, a loading hint instead.
    expect(screen.getByText("Loading identities…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Add a server identity/ }),
    ).not.toBeInTheDocument();

    identitiesLoad.resolve({ identities: [IDENTITY] });
    accountsLoad.resolve({ accounts: [ACCOUNT], canRemember: false });
    expect(
      await screen.findByRole("button", { name: /Add a server identity/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading identities…")).not.toBeInTheDocument();
  });

  it("a post-load add on a one-account picker goes straight to its characters", async () => {
    const user = userEvent.setup();
    listIdentities.mockResolvedValue({ identities: [IDENTITY] });
    listFlistAccounts.mockResolvedValue({
      accounts: [ACCOUNT],
      canRemember: false,
    });
    listCharacters.mockResolvedValue({
      characters: ["Rowan Redleaf", "Petal Thorn"],
    });
    renderPicker();

    await user.click(
      await screen.findByRole("button", { name: /Add a server identity/ }),
    );
    // The character picker, not the new-account form: the loaded account is
    // what the flow must snapshot. (listitem's ARIA name is not from content,
    // so match by text like the E2E's hasText filter does.)
    const rows = await screen.findAllByRole("listitem");
    expect(rows.some((row) => row.textContent?.includes("Petal Thorn"))).toBe(
      true,
    );
    expect(
      screen.queryByLabelText("F-List account name"),
    ).not.toBeInTheDocument();
  });
});

describe("shared-account notice (#573)", () => {
  it("holds the handoff on a warning until Continue", async () => {
    const user = userEvent.setup();
    listIdentities.mockResolvedValue({ identities: [] });
    listFlistAccounts.mockResolvedValue({ accounts: [], canRemember: false });
    listCharacters.mockResolvedValue({ characters: ["Rowan Redleaf"] });
    // The add succeeded — the warning rides beside the account, and the
    // account must not be lost while the notice is on screen.
    addFlistAccount.mockResolvedValue({
      account: ACCOUNT,
      warning: "Someone else on this server already uses this F-List account.",
    });
    renderPicker();

    await user.click(
      await screen.findByRole("button", { name: /Add a server identity/ }),
    );
    await user.type(
      await screen.findByLabelText("F-List account name"),
      "rowan@example.test",
    );
    await user.type(screen.getByLabelText("F-List password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Verify account" }));

    // The notice replaces the form; the character list waits behind Continue.
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toMatch(/already uses this F-List account/);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    const rows = await screen.findAllByRole("listitem");
    expect(rows.some((row) => row.textContent?.includes("Rowan Redleaf"))).toBe(
      true,
    );
  });
});
