// @vitest-environment jsdom
//
// One MediaQueryList subscription for the whole app (MP1 §5-F). useNoHover()
// is called from a per-eicon component, so a name-only log mounts hundreds of
// consumers; each holding its own listener for the same global boolean is the
// shape this module exists to avoid.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { noHoverNow, NO_HOVER_QUERY, useNoHover } from "./pointer.js";

/** A matchMedia stub that records its listeners, so a test can both count
 * them and fire a capability change through them. */
function stubMatchMedia(matches: boolean) {
  const handlers = new Set<() => void>();
  const state = { matches };
  vi.stubGlobal("matchMedia", (query: string): MediaQueryList => {
    expect(query).toBe(NO_HOVER_QUERY);
    return {
      get matches() {
        return state.matches;
      },
      media: query,
      addEventListener: (_: string, handler: () => void) => {
        handlers.add(handler);
      },
      removeEventListener: (_: string, handler: () => void) => {
        handlers.delete(handler);
      },
    } as unknown as MediaQueryList;
  });
  return {
    handlers,
    set(next: boolean) {
      state.matches = next;
      act(() => {
        for (const handler of [...handlers]) {
          handler();
        }
      });
    },
  };
}

function Probe({ id }: { id: string }) {
  return <span data-testid={id}>{useNoHover() ? "touch" : "hover"}</span>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useNoHover", () => {
  it("installs one listener however many components ask", () => {
    const media = stubMatchMedia(true);
    const view = render(
      <>
        <Probe id="a" />
        <Probe id="b" />
        <Probe id="c" />
      </>,
    );

    expect(screen.getByTestId("a")).toHaveTextContent("touch");
    expect(screen.getByTestId("c")).toHaveTextContent("touch");
    expect(media.handlers.size).toBe(1);

    // …and drops it again once the last consumer unmounts, rather than
    // leaking one per eicon that ever scrolled through the log.
    view.unmount();
    expect(media.handlers.size).toBe(0);
  });

  it("wakes every consumer when the capability changes", () => {
    const media = stubMatchMedia(false);
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    expect(screen.getByTestId("a")).toHaveTextContent("hover");

    media.set(true);
    expect(screen.getByTestId("a")).toHaveTextContent("touch");
    expect(screen.getByTestId("b")).toHaveTextContent("touch");
    expect(media.handlers.size).toBe(1);
  });

  it("answers 'the pointer can hover' where nothing can be asked", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(noHoverNow()).toBe(false);
    render(<Probe id="a" />);
    expect(screen.getByTestId("a")).toHaveTextContent("hover");
  });
});
