// @vitest-environment jsdom
//
// The mark is the config'd product name and nothing else (#537). The old auth
// lockup derived a purple chip from `appName.charAt(0)` and printed
// `appName.toLowerCase()` beside it — two transformations of the name that a
// self-hoster who renamed the product would have had no say in, and a second
// wordmark for a product that has one.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Wordmark } from "./Wordmark.js";

const appConfig = vi.hoisted(() => vi.fn());
vi.mock("../../lib/config.js", () => ({ appConfig }));

describe("Wordmark", () => {
  it("renders the configured product name verbatim", () => {
    appConfig.mockReturnValue({ appName: "Hearthline" });
    render(<Wordmark />);
    expect(screen.getByTestId("wordmark")).toHaveTextContent(/^Hearthline$/);
  });
});
