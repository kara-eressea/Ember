// @vitest-environment jsdom
//
// The Insights activity grid: 7×24 cells with per-cell tooltips, the busiest
// slot in the summary, the "only while connected" honesty line, and an empty
// state that doesn't pretend a silent grid means a silent character.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ProfileActivity } from "@emberchat/protocol";
import { ActivityHeatmap } from "./ActivityHeatmap.js";

function activity(overrides: Partial<ProfileActivity> = {}): ProfileActivity {
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  grid[3]![21] = 12;
  grid[0]![9] = 4;
  return {
    windowDays: 90,
    total: 16,
    grid,
    timezone: "Europe/Berlin",
    ...overrides,
  };
}

describe("ActivityHeatmap", () => {
  it("draws every weekday × hour cell with a readable tooltip", () => {
    const { container } = render(<ActivityHeatmap activity={activity()} />);
    expect(container.querySelectorAll("[title]")).toHaveLength(7 * 24 + 7);
    expect(
      screen.getByTitle("Thursday 21:00–22:00 · 12 messages"),
    ).toBeInTheDocument();
    // Singular/plural, and quiet cells are still described.
    expect(
      screen.getByTitle("Monday 00:00–01:00 · 0 messages"),
    ).toBeInTheDocument();
  });

  it("summarizes the busiest slot and the window", () => {
    render(<ActivityHeatmap activity={activity()} />);
    expect(
      screen.getByText(/Busiest Thursday around 21:00/),
    ).toBeInTheDocument();
    expect(screen.getByText(/16 messages in 90 days/)).toBeInTheDocument();
  });

  it("labels the axis with the viewer's own zone", () => {
    render(<ActivityHeatmap activity={activity()} />);
    expect(screen.getByText(/Europe\/Berlin · your time/)).toBeInTheDocument();
  });

  it("says the counts only cover what the bouncer saw", () => {
    render(<ActivityHeatmap activity={activity()} />);
    expect(screen.getByText(/while it was connected/)).toBeInTheDocument();
  });

  it("renders an empty state instead of a grid when nothing was seen", () => {
    const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const { container } = render(
      <ActivityHeatmap activity={activity({ grid, total: 0 })} />,
    );
    expect(screen.getByText(/Nothing in the last 90 days/)).toBeInTheDocument();
    expect(container.querySelector('[role="img"]')).toBeNull();
    // The honesty line stays: an empty grid is exactly where it matters.
    expect(screen.getByText(/while it was connected/)).toBeInTheDocument();
  });
});
