/*
  The error page's whole script (design/mx3-desktop-shell.md §5).

  It knows three things: what the main process told it at load time (the query
  parameters), which of two buttons was pressed, and what came back. Every
  decision — probing the server again, opening a window, reopening the chooser
  — happens on the other side of `window.emberchat`, exposed by
  error-preload.cts. This file does not fetch, does not store, and cannot reach
  anything the page's CSP has not allowed.

  Plain browser JS on purpose: no bundler runs over this directory.
*/

const params = new URLSearchParams(window.location.search);
const productName = params.get("product") ?? "";
const retryButton = document.getElementById("retry");
const switchButton = document.getElementById("switch");

// The product name is config (CLAUDE.md), so the markup ships with a generic
// stand-in and every mention is filled in here.
if (productName !== "") {
  for (const slot of document.querySelectorAll("[data-product]")) {
    slot.textContent = productName;
  }
}

document.querySelector("[data-address]").textContent = params.get("url") ?? "";
showFailure({
  headline: params.get("headline") ?? "",
  detail: params.get("detail") ?? "",
  code: params.get("code") ?? "",
});

retryButton.addEventListener("click", () => {
  void act(() => window.emberchat.retry());
});

switchButton.addEventListener("click", () => {
  void act(() => window.emberchat.switchMode());
});

/**
 * Runs one action at a time and shows whatever comes back.
 *
 * A successful action never returns to this page in a useful state — the main
 * process opens the app window or the chooser and closes this one — so the only
 * outcome worth handling is a failure, and the interesting case is a failure
 * that is *different* from the one on screen: a server that was down and now
 * has an expired certificate should say so, headline and all.
 *
 * @param {() => Promise<{ ok: boolean, failure?: { headline: string, detail: string, code?: string } }>} call
 */
async function act(call) {
  setBusy(true);
  try {
    const result = await call();
    if (!result.ok && result.failure !== undefined) {
      showFailure(result.failure);
    }
  } catch {
    // An IPC handler that threw rather than answering. The user cannot act on
    // a stack trace, and the main process has already logged it.
    showFailure({
      headline: "That didn't work",
      detail: "Something went wrong trying again. The address is unchanged.",
      code: "",
    });
  } finally {
    setBusy(false);
  }
}

/** @param {{ headline: string, detail: string, code?: string }} failure */
function showFailure(failure) {
  if (failure.headline !== "") {
    document.querySelector("[data-headline]").textContent = failure.headline;
    document.title = failure.headline;
  }
  document.querySelector("[data-detail]").textContent = failure.detail;
  const code = failure.code ?? "";
  const codeLabel = document.querySelector("[data-code-label]");
  const codeValue = document.querySelector("[data-code]");
  codeValue.textContent = code;
  codeLabel.hidden = code === "";
  codeValue.hidden = code === "";
}

function setBusy(busy) {
  document.body.classList.toggle("busy", busy);
  retryButton.disabled = busy;
  switchButton.disabled = busy;
}
