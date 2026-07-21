import { describe, expect, it } from "vitest";
import {
  apiTicketResponseSchema,
  characterDataSchema,
  guestbookSchema,
  infoListSchema,
  kinkListSchema,
  mappingListSchema,
  memoGetSchema,
} from "./flist-api.js";

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

// Fixtures mirror the live shapes verified 2026-07-17
// (design/chat-json-endpoints.md "Verified shapes") with fabricated data.

describe("characterDataSchema", () => {
  it("parses a success payload, coercing string-typed numbers", () => {
    const parsed = characterDataSchema.parse({
      id: 1234567,
      name: "Amber Vale",
      description: "[b]Hi[/b]",
      views: 42,
      customs_first: true,
      custom_title: "",
      is_self: false,
      settings: {
        customs_first: true,
        show_friends: false,
        guestbook: true,
        prevent_bookmarks: false,
        public: true,
      },
      badges: [],
      created_at: 1499496292,
      updated_at: 1674368554,
      kinks: { "6": "no", "7": "fave" },
      custom_kinks: {
        "29732429": {
          name: "A custom kink",
          description: "…",
          choice: "yes",
          children: [620],
        },
      },
      infotags: { "1": "116", "2": "5", "9": "Elf" },
      inlines: {},
      images: [
        {
          image_id: "16478725",
          extension: "jpg",
          height: "2000",
          width: "1442",
          description: "Portrait",
          sort_order: "0",
        },
      ],
      timezone: 1,
      error: "",
    });
    expect(parsed.images?.[0]).toMatchObject({
      image_id: 16478725,
      height: 2000,
      sort_order: 0,
    });
    expect(parsed.settings?.guestbook).toBe(true);
  });

  it("normalizes PHP empty-array serialization of record fields to {}", () => {
    // A character with no kinks/customs/infotags/inlines: PHP serializes
    // the empty associative arrays as [] (issue #179).
    const parsed = characterDataSchema.parse({
      id: 1234567,
      name: "Amber Vale",
      description: "",
      views: 1,
      kinks: [],
      custom_kinks: [],
      infotags: [],
      inlines: [],
      images: [],
      error: "",
    });
    expect(parsed.kinks).toEqual({});
    expect(parsed.custom_kinks).toEqual({});
    expect(parsed.infotags).toEqual({});
    expect(parsed.inlines).toEqual({});
  });

  it("still rejects non-empty arrays for record fields", () => {
    expect(
      characterDataSchema.safeParse({ error: "", kinks: ["6"] }).success,
    ).toBe(false);
  });

  it("parses a failure payload (error only, HTTP 200)", () => {
    const parsed = characterDataSchema.parse({
      error: "Character not found.",
    });
    expect(parsed.error).not.toBe("");
    expect(parsed.name).toBeUndefined();
  });
});

describe("mappingListSchema", () => {
  it("coerces the all-string wire values", () => {
    const parsed = mappingListSchema.parse({
      kinks: [{ id: "8", name: "A kink", description: "…", group_id: "42" }],
      kink_groups: [{ id: "27", name: "General Kinks" }],
      infotags: [
        {
          id: "2",
          name: "Orientation",
          type: "list",
          list: "orientation",
          group_id: "3",
        },
        { id: "1", name: "Age", type: "text", list: "", group_id: "3" },
      ],
      infotag_groups: [{ id: "1", name: "Contact details/Sites" }],
      listitems: [{ id: "5", name: "orientation", value: "Straight" }],
      error: "",
    });
    expect(parsed.kinks?.[0]).toMatchObject({ id: 8, group_id: 42 });
    expect(parsed.infotags?.[0]?.list).toBe("orientation");
    expect(parsed.listitems?.[0]?.id).toBe(5);
  });
});

describe("kinkListSchema / infoListSchema", () => {
  it("parses grouped kinks keyed by group id", () => {
    const parsed = kinkListSchema.parse({
      kinks: {
        "31": {
          group: "Age Related",
          items: [{ kink_id: 620, name: "Age Differences", description: "…" }],
        },
      },
      error: "",
    });
    expect(parsed.kinks?.["31"]?.items[0]?.kink_id).toBe(620);
  });

  it("parses grouped infotags with optional dropdown options", () => {
    const parsed = infoListSchema.parse({
      info: {
        "3": {
          group: "General details",
          items: [{ id: 1, name: "Age", type: "text" }],
        },
      },
      error: "",
    });
    expect(parsed.info?.["3"]?.items[0]?.name).toBe("Age");
  });
});

describe("guestbookSchema", () => {
  it("parses a live-shaped page of posts", () => {
    const parsed = guestbookSchema.parse({
      posts: [
        {
          id: 305179,
          character: { id: 2167793, name: "Birch Rowan" },
          postedAt: 1520787424,
          message: "Hello!",
          reply: null,
          private: false,
          approved: true,
          canEdit: false,
        },
      ],
      page: 0,
      canEdit: true,
      nextPage: false,
      error: "",
    });
    expect(parsed.posts?.[0]?.character.name).toBe("Birch Rowan");
    expect(parsed.nextPage).toBe(false);
  });

  it("parses the disabled-guestbook error case", () => {
    const parsed = guestbookSchema.parse({
      error: "This character does not have a guestbook.",
    });
    expect(parsed.posts).toBeUndefined();
  });
});

describe("memoGetSchema", () => {
  it("parses the no-memo case (note null)", () => {
    const parsed = memoGetSchema.parse({ note: null, id: 1622337, error: "" });
    expect(parsed.note).toBeNull();
    expect(parsed.id).toBe(1622337);
  });

  it("parses an existing memo", () => {
    const parsed = memoGetSchema.parse({
      note: "met at the inn",
      id: 99,
      error: "",
    });
    expect(parsed.note).toBe("met at the inn");
  });
});
