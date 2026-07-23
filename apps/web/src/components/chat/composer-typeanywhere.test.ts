import { describe, expect, it } from "vitest";
import {
  shouldRedirectToComposer,
  type TypeAnywhereContext,
  type TypeAnywhereKey,
} from "./composer-typeanywhere.js";

function key(over: Partial<TypeAnywhereKey> = {}): TypeAnywhereKey {
  return {
    key: "a",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    isComposing: false,
    ...over,
  };
}

function ctx(over: Partial<TypeAnywhereContext> = {}): TypeAnywhereContext {
  return { activeElement: null, modalOpen: false, ...over };
}

// A stand-in for whatever element document.activeElement points at.
function element(tag: string, contentEditable = false): Element {
  return {
    tagName: tag.toUpperCase(),
    isContentEditable: contentEditable,
  } as unknown as Element;
}

describe("shouldRedirectToComposer (#395)", () => {
  it("redirects a bare printable character with nothing focused", () => {
    expect(shouldRedirectToComposer(key({ key: "h" }), ctx())).toBe(true);
  });

  it("redirects digits, punctuation, space and non-ASCII letters", () => {
    for (const k of ["7", "!", " ", "é"]) {
      expect(shouldRedirectToComposer(key({ key: k }), ctx())).toBe(true);
    }
  });

  it("ignores named/navigation keys", () => {
    for (const k of ["Enter", "Escape", "ArrowUp", "Tab", "Backspace", "F5"]) {
      expect(shouldRedirectToComposer(key({ key: k }), ctx())).toBe(false);
    }
  });

  it("ignores Ctrl/Meta/Alt modifier combos (e.g. Ctrl+K)", () => {
    expect(
      shouldRedirectToComposer(key({ key: "k", ctrlKey: true }), ctx()),
    ).toBe(false);
    expect(
      shouldRedirectToComposer(key({ key: "k", metaKey: true }), ctx()),
    ).toBe(false);
    expect(
      shouldRedirectToComposer(key({ key: "a", altKey: true }), ctx()),
    ).toBe(false);
  });

  it("does not steal a keystroke already claimed by another handler", () => {
    expect(
      shouldRedirectToComposer(key({ defaultPrevented: true }), ctx()),
    ).toBe(false);
  });

  it("ignores keystrokes mid-IME-composition", () => {
    expect(shouldRedirectToComposer(key({ isComposing: true }), ctx())).toBe(
      false,
    );
  });

  it("ignores typing while an input/textarea/select is focused", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(
        shouldRedirectToComposer(key(), ctx({ activeElement: element(tag) })),
      ).toBe(false);
    }
  });

  it("ignores typing while a contenteditable (the composer itself) is focused", () => {
    expect(
      shouldRedirectToComposer(
        key(),
        ctx({ activeElement: element("div", true) }),
      ),
    ).toBe(false);
  });

  it("still redirects when focus is on inert chrome (a div/button)", () => {
    expect(
      shouldRedirectToComposer(key(), ctx({ activeElement: element("div") })),
    ).toBe(true);
  });

  it("ignores every keystroke while a modal/palette is open", () => {
    expect(shouldRedirectToComposer(key(), ctx({ modalOpen: true }))).toBe(
      false,
    );
  });
});
