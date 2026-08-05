/*
  The chooser page's whole script (design/mx3-desktop-shell.md §4).

  It knows two things: which button was pressed, and what the main process said
  about it. Every decision — is that a valid address, does it answer /healthz,
  what gets written where, does the app relaunch — happens on the other side of
  `window.emberchat`, exposed by chooser-preload.cts. This file does not fetch,
  does not store, and cannot reach anything the page's CSP has not allowed.

  Plain browser JS on purpose: no bundler runs over this directory, and the two
  files it would need to import (the channel names, the result type) are the
  preload's business, not the page's.
*/

const params = new URLSearchParams(window.location.search);
const productName = params.get("product") ?? "";
const localButton = document.getElementById("local");
const connectForm = document.getElementById("connect-form");
const connectButton = document.getElementById("connect");
const urlField = document.getElementById("server-url");
const message = document.getElementById("message");

// The product name is config (CLAUDE.md), so the markup ships with a generic
// stand-in and every mention is filled in here.
if (productName !== "") {
  for (const slot of document.querySelectorAll("[data-product]")) {
    slot.textContent = productName;
  }
  document.title = productName;
}

// Prefilled when an existing thin-client setup is being changed, so "Switch
// mode…" does not ask the user to retype an address the app already knows.
urlField.value = params.get("url") ?? "";

localButton.addEventListener("click", () => {
  void choose(() => window.emberchat.chooseLocal());
});

connectForm.addEventListener("submit", (event) => {
  // The CSP forbids form submission outright; this is belt and braces, and it
  // is what makes Enter in the field mean "connect".
  event.preventDefault();
  void choose(() => window.emberchat.chooseThinClient(urlField.value));
});

/**
 * Runs one choice at a time and shows whatever comes back.
 *
 * A successful choice never returns to this page in a useful state — the
 * window is closed by the main process, or the whole app relaunches — so the
 * only outcome worth handling is a refusal.
 *
 * @param {() => Promise<{ ok: boolean, message?: string }>} call
 */
async function choose(call) {
  setBusy(true);
  showMessage("");
  try {
    const result = await call();
    if (!result.ok) {
      showMessage(result.message ?? "That didn't work.");
    }
  } catch {
    // An IPC handler that threw rather than answering. The user cannot act on
    // the stack trace, and the main process has already logged it.
    showMessage("Something went wrong saving that choice. Please try again.");
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  document.body.classList.toggle("busy", busy);
  localButton.disabled = busy;
  connectButton.disabled = busy;
  urlField.disabled = busy;
}

function showMessage(text) {
  message.textContent = text;
  message.hidden = text === "";
}
