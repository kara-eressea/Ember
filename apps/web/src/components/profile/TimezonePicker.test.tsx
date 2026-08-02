// @vitest-environment jsdom
//
// The per-character timezone field: picking a real zone saves without a
// separate step, ✕ forgets it (falling back to the profile's own offset),
// and a failed write says so instead of silently pretending.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../../lib/api.js";
import { useProfileStore } from "../../stores/profile.js";
import { TimezonePicker } from "./TimezonePicker.js";

const ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  vi.restoreAllMocks();
  useProfileStore.setState({ profiles: {} });
});

describe("TimezonePicker", () => {
  it("saves as soon as the text is a real zone, and not before", async () => {
    const put = vi.spyOn(api, "putProfileTimezone").mockResolvedValue({
      ok: true,
    });
    render(
      <TimezonePicker
        identityId={ID}
        name="Nyx Firemane"
        initial={null}
        flistOffset={null}
      />,
    );
    const field = screen.getByLabelText("Timezone for Nyx Firemane");
    await userEvent.type(field, "Europe/Ber");
    expect(put).not.toHaveBeenCalled();
    await userEvent.type(field, "lin");
    expect(put).toHaveBeenCalledWith(ID, "Nyx Firemane", "Europe/Berlin");
  });

  it("clears back to the profile's own offset", async () => {
    const put = vi.spyOn(api, "putProfileTimezone").mockResolvedValue({
      ok: true,
    });
    render(
      <TimezonePicker
        identityId={ID}
        name="Nyx Firemane"
        initial="Europe/Berlin"
        flistOffset={-5}
      />,
    );
    await userEvent.click(
      screen.getByLabelText("Clear the timezone for Nyx Firemane"),
    );
    expect(put).toHaveBeenCalledWith(ID, "Nyx Firemane", null);
    // The clock now names the fallback source rather than disappearing.
    expect(screen.getByText(/UTC-5, from their profile/)).toBeInTheDocument();
  });

  it("shows the clock from the user-set zone, attributed to them", () => {
    render(
      <TimezonePicker
        identityId={ID}
        name="Nyx Firemane"
        initial="Europe/Berlin"
        flistOffset={-5}
      />,
    );
    expect(screen.getByText(/your answer/)).toBeInTheDocument();
  });

  it("says nothing is known when neither source has an answer", () => {
    render(
      <TimezonePicker
        identityId={ID}
        name="Nyx Firemane"
        initial={null}
        flistOffset={null}
      />,
    );
    expect(screen.getByText(/their profile doesn't say/)).toBeInTheDocument();
  });

  it("surfaces a failed write instead of swallowing it", async () => {
    vi.spyOn(api, "putProfileTimezone").mockRejectedValue(new Error("nope"));
    render(
      <TimezonePicker
        identityId={ID}
        name="Nyx Firemane"
        initial="Europe/Berlin"
        flistOffset={null}
      />,
    );
    await userEvent.click(
      screen.getByLabelText("Clear the timezone for Nyx Firemane"),
    );
    expect(await screen.findByText("⚠ Not saved")).toBeInTheDocument();
  });
});
