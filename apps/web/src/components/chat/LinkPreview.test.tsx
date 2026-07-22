// @vitest-environment jsdom
//
// Component-render tier (issue #268): the LinkPreview panel must degrade — a
// dead link or transient media error keeps the frame and shows a quiet "could
// not be loaded" state with the raw URL still reachable, rather than flashing
// the panel away (#193). This drives the img onError path in the DOM.

import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LinkPreview } from "./LinkPreview.js";
import { useLinkPreviewStore } from "../../stores/link-preview.js";
import type { PreviewSource } from "../../lib/link-preview.js";

const anchor = { top: 100, left: 100, bottom: 120, right: 200 };
const imageSource: PreviewSource = {
  src: "https://i.imgur.com/abc.png",
  kind: "image",
  host: "i.imgur.com",
  path: "abc.png",
};

afterEach(() => {
  useLinkPreviewStore.getState().close();
});

describe("LinkPreview error fallback (#193)", () => {
  it("shows the quiet not-found state and keeps the URL when the image errors", () => {
    useLinkPreviewStore
      .getState()
      .open(imageSource, "https://imgur.com/abc", anchor, "click");
    render(<LinkPreview />);

    // Starts in the loading frame: the image is mounted but hidden.
    const img = screen.getByRole("img", { hidden: true });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.error(img);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not be loaded/i);
    // The raw URL stays reachable in a new tab.
    const escape = screen.getByRole("link", { name: /open link in a new tab/i });
    expect(escape).toHaveAttribute("href", "https://imgur.com/abc");
    // The image is gone once we degrade.
    expect(screen.queryByRole("img", { hidden: true })).not.toBeInTheDocument();
  });

  it("renders the media once it loads", () => {
    useLinkPreviewStore
      .getState()
      .open(imageSource, "https://imgur.com/abc", anchor, "click");
    render(<LinkPreview />);
    const img = screen.getByRole("img", { hidden: true });
    fireEvent.load(img);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(img).toBeVisible();
  });
});
