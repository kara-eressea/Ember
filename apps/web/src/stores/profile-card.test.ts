// @vitest-environment jsdom
//
// Mini-card anchoring: the store keeps the trigger itself (not just the rect
// it had at open time) so the card can re-measure while the log scrolls
// under it, and the click-away bookkeeping that replaced the old
// click-swallowing overlay — pressing another name must close this card and
// open that one in the same gesture, while pressing the open card's own
// trigger toggles it shut.

import { beforeEach, describe, expect, it } from "vitest";
import { liveAnchor, openCardFrom, useProfileStore } from "./profile.js";

function trigger(rect: { top: number; left: number }): HTMLButtonElement {
  const element = document.createElement("button");
  element.getBoundingClientRect = () =>
    ({
      top: rect.top,
      left: rect.left,
      bottom: rect.top + 20,
      right: rect.left + 100,
    }) as DOMRect;
  document.body.append(element);
  return element;
}

beforeEach(() => {
  document.body.replaceChildren();
  useProfileStore.setState({ card: undefined });
});

describe("openCardFrom", () => {
  it("snapshots the trigger's rect and keeps the trigger", () => {
    const button = trigger({ top: 100, left: 40 });
    openCardFrom(button, "Nyx Firemane");

    expect(useProfileStore.getState().card).toEqual({
      name: "Nyx Firemane",
      anchor: { top: 100, left: 40, bottom: 120, right: 140 },
      element: button,
    });
  });

  it("closes and reopens when another name is pressed in one gesture", () => {
    const nyx = trigger({ top: 100, left: 40 });
    const cindral = trigger({ top: 200, left: 40 });
    openCardFrom(nyx, "Nyx Firemane");

    // pointerdown outside the card lands on the other name…
    useProfileStore.getState().dismissCard(cindral);
    expect(useProfileStore.getState().card).toBeUndefined();
    // …and the click that follows opens that one.
    openCardFrom(cindral, "Cindral");
    expect(useProfileStore.getState().card?.name).toBe("Cindral");
  });

  it("toggles shut when the open card's own trigger is pressed", () => {
    const nyx = trigger({ top: 100, left: 40 });
    const label = document.createElement("span");
    nyx.append(label);
    openCardFrom(nyx, "Nyx Firemane");

    useProfileStore.getState().dismissCard(label);
    openCardFrom(nyx, "Nyx Firemane");
    expect(useProfileStore.getState().card).toBeUndefined();
  });

  it("forgets the dismissal after the gesture it belongs to", () => {
    const nyx = trigger({ top: 100, left: 40 });
    openCardFrom(nyx, "Nyx Firemane");
    useProfileStore.getState().dismissCard(nyx);
    openCardFrom(nyx, "Nyx Firemane"); // consumed: stays closed

    openCardFrom(nyx, "Nyx Firemane");
    expect(useProfileStore.getState().card?.name).toBe("Nyx Firemane");
  });
});

describe("liveAnchor", () => {
  it("re-measures a trigger that is still in the document", () => {
    const button = trigger({ top: 300, left: 12 });
    expect(liveAnchor(button)).toEqual({
      top: 300,
      left: 12,
      bottom: 320,
      right: 112,
    });
  });

  it("reports nothing once the trigger is gone (virtualized away)", () => {
    const button = trigger({ top: 300, left: 12 });
    button.remove();
    expect(liveAnchor(button)).toBeUndefined();
    expect(liveAnchor(undefined)).toBeUndefined();
  });
});
