// @vitest-environment jsdom
//
// The mark is the product name and nothing else (#537). The old auth lockup
// derived a purple chip from the name's first character and printed the name
// lowercased in mono beside it — two transformations of a name the product
// never asked for, and a second wordmark for a product that has one.

import { render, screen } from "@testing-library/react";
import { APP_NAME } from "@emberchat/protocol";
import { describe, expect, it } from "vitest";
import { Wordmark } from "./Wordmark.js";

describe("Wordmark", () => {
  it("renders the product name verbatim", () => {
    render(<Wordmark />);
    expect(screen.getByTestId("wordmark")).toHaveTextContent(
      new RegExp(`^${APP_NAME}$`),
    );
  });
});
