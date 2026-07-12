import { describe, expect, it } from "vitest";
import { apiTicketResponseSchema } from "./flist-api.js";

describe("apiTicketResponseSchema", () => {
  it("parses a successful ticket response", () => {
    const parsed = apiTicketResponseSchema.parse({
      error: "",
      ticket: "fct_0123456789abcdef",
      characters: ["Amber Vale", "Cindral"],
      default_character: "Amber Vale",
      friends: [{ source_name: "Amber Vale", dest_name: "Birch Rowan" }],
      bookmarks: [{ name: "Nyx Firemane" }],
    });
    expect(parsed).toHaveProperty("ticket", "fct_0123456789abcdef");
  });

  it("parses a response with data omitted via no_* flags", () => {
    const parsed = apiTicketResponseSchema.parse({
      error: "",
      ticket: "fct_abc",
    });
    expect(parsed).not.toHaveProperty("characters");
  });

  it("parses a failure response", () => {
    const parsed = apiTicketResponseSchema.parse({
      error: "Invalid username or password.",
    });
    expect(parsed).toEqual({ error: "Invalid username or password." });
    expect(parsed).not.toHaveProperty("ticket");
  });

  it("rejects a success shape with no ticket", () => {
    expect(apiTicketResponseSchema.safeParse({ error: "" }).success).toBe(
      false,
    );
  });
});
