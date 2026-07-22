// Character-data endpoints for the sim: profiles, the bulk mapping lists,
// guestbooks, memos, and a xariah-style eicon index. Wire shapes mirror the
// live responses verified 2026-07-17 (design/chat-json-endpoints.md
// "Verified shapes") — string-typed numbers in character-data images and
// mapping-list included, so schema coercion gets exercised for real.
// Everything here is fixture data — never real F-List content.

import type { SimNpc, SimWorld } from "./world.js";

/** Seed/override for one character's profile. Every field optional — known
 * world characters get a serviceable default profile without any setup. */
export interface SimCharacterProfileSeed {
  readonly description?: string;
  readonly views?: number;
  readonly customTitle?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  /** Merged over the defaults (guestbook defaults to false). */
  readonly settings?: Partial<{
    customsFirst: boolean;
    showFriends: boolean;
    guestbook: boolean;
    preventBookmarks: boolean;
    public: boolean;
  }>;
  /** kink id → "fave" | "yes" | "maybe" | "no". */
  readonly kinks?: Readonly<Record<string, string>>;
  readonly customKinks?: Readonly<
    Record<
      string,
      {
        name: string;
        description?: string;
        choice?: string;
        children?: readonly number[];
      }
    >
  >;
  /** infotag id → value (listitem id as a string for list-type tags). */
  readonly infotags?: Readonly<Record<string, string>>;
  readonly images?: readonly {
    id: number;
    extension: string;
    height?: number;
    width?: number;
    description?: string;
  }[];
  /** Inline images (`[img]id[/img]` in the description) keyed by id. */
  readonly inlines?: Readonly<
    Record<string, { hash: string; extension: string; nyan?: number }>
  >;
  readonly timezone?: number;
}

export interface SimGuestbookPostSeed {
  readonly from: string;
  readonly message: string;
  /** Unix seconds. */
  readonly postedAt?: number;
  readonly reply?: string;
  readonly private?: boolean;
}

// ── Canned mapping set ────────────────────────────────────────────────────────
// Infotag ids are the real F-List ones (the matcher keys on them: Age 1,
// Orientation 2, Gender 3, Species 9, Build 13, Sub/Dom Role 15, Furry
// preference 29, Position 41). Listitem ids are sim-local but the values
// match the real option lists; kink ids 8/620 come from the verified spike.

interface CannedListFamily {
  readonly family: string;
  readonly values: readonly string[];
}

const LIST_FAMILIES: readonly CannedListFamily[] = [
  {
    family: "gender",
    values: [
      "Male",
      "Female",
      "Transgender",
      "Herm",
      "Male-Herm",
      "Shemale",
      "Cunt-boy",
      "None",
    ],
  },
  {
    family: "orientation",
    values: ["Straight", "Gay", "Bisexual", "Pansexual", "Asexual", "Unsure"],
  },
  {
    family: "subdom",
    values: [
      "Always dominant",
      "Usually dominant",
      "Switch",
      "Usually submissive",
      "Always submissive",
    ],
  },
  {
    family: "furrypref",
    values: [
      "No furry characters, just humans",
      "Furries ok, Humans Preferred",
      "Furs and / or humans",
      "Humans ok, Furries Preferred",
      "No humans, just furry characters",
    ],
  },
  { family: "position", values: ["Top", "Bottom", "Switch"] },
  { family: "build", values: ["Slim", "Athletic", "Curvy", "Muscular"] },
];

const INFOTAG_GROUPS = [
  { id: 1, name: "Contact details/Sites" },
  { id: 2, name: "Sexual details" },
  { id: 3, name: "General details" },
  { id: 5, name: "RPing preferences" },
] as const;

const INFOTAGS = [
  { id: 1, name: "Age", type: "text", list: "", groupId: 3 },
  { id: 2, name: "Orientation", type: "list", list: "orientation", groupId: 2 },
  { id: 3, name: "Gender", type: "list", list: "gender", groupId: 3 },
  { id: 9, name: "Species", type: "text", list: "", groupId: 3 },
  { id: 13, name: "Build", type: "list", list: "build", groupId: 3 },
  { id: 15, name: "Dom/Sub Role", type: "list", list: "subdom", groupId: 2 },
  {
    id: 29,
    name: "Furry preference",
    type: "list",
    list: "furrypref",
    groupId: 5,
  },
  { id: 41, name: "Position", type: "list", list: "position", groupId: 2 },
] as const;

const KINK_GROUPS = [
  { id: 27, name: "General Kinks" },
  { id: 31, name: "Age Related" },
  { id: 42, name: "Verbal" },
] as const;

const KINKS = [
  {
    id: 8,
    name: "Dirty Talking",
    description: "Explicit speech during a scene.",
    groupId: 42,
  },
  {
    id: 620,
    name: "Age Differences",
    description: "Adult characters with significant age gaps.",
    groupId: 31,
  },
  {
    id: 501,
    name: "Campfire Stories",
    description: "Long tales told in warm light.",
    groupId: 27,
  },
  {
    id: 502,
    name: "Tea Ceremonies",
    description: "Quiet ritual and good company.",
    groupId: 27,
  },
] as const;

/** Deterministic fixture clock — sims must be reproducible run to run. */
const DEFAULT_AS_OF = 1_752_000_000;

const DEFAULT_EICONS = ["campfire", "emberlogo", "teacup", "lanternlight"];

/** Character ids start here; assigned in first-seen order, stable per run. */
const FIRST_CHARACTER_ID = 2_000_001;

interface EiconDelta {
  readonly action: "+" | "-";
  readonly name: string;
  /** Unix seconds. */
  readonly at: number;
}

export class CharacterService {
  readonly #knownCharacters = new Set<string>();
  readonly #npcByName = new Map<string, SimNpc>();
  readonly #idByLower = new Map<string, number>();
  readonly #nameByLower = new Map<string, string>();
  readonly #profiles = new Map<string, SimCharacterProfileSeed>();
  readonly #guestbooks = new Map<string, SimGuestbookPostSeed[]>();
  /** `account + "\u0000" + characterLower` → memo text. */
  readonly #memos = new Map<string, string>();
  #eicons: string[] = [...DEFAULT_EICONS];
  #eiconAsOf = DEFAULT_AS_OF;
  #eiconDeltas: EiconDelta[] = [];
  #nextId = FIRST_CHARACTER_ID;

  constructor(world: SimWorld) {
    for (const account of Object.values(world.accounts)) {
      for (const character of account.characters) {
        this.#knownCharacters.add(character);
      }
    }
    for (const npc of world.npcs) {
      this.#knownCharacters.add(npc.name);
      this.#npcByName.set(npc.name, npc);
      if (npc.images || npc.inlines || npc.description !== undefined) {
        this.setProfile(npc.name, {
          ...(npc.images ? { images: npc.images } : {}),
          ...(npc.description !== undefined
            ? { description: npc.description }
            : {}),
          ...(npc.inlines
            ? {
                inlines: Object.fromEntries(
                  npc.inlines.map((inline) => [
                    String(inline.id),
                    { hash: inline.hash, extension: inline.extension },
                  ]),
                ),
              }
            : {}),
        });
      }
    }
  }

  /** Stable numeric id (assigned on first use) — mirrors character-data's id
   * and feeds the guestbook endpoint. Works for any name, like the real
   * site: guestbook posters don't have to be world characters. */
  idOf(name: string): number {
    const lower = name.toLowerCase();
    let id = this.#idByLower.get(lower);
    if (id === undefined) {
      id = this.#nextId++;
      this.#idByLower.set(lower, id);
      this.#nameByLower.set(lower, name);
    }
    return id;
  }

  setProfile(name: string, seed: SimCharacterProfileSeed): void {
    this.#knownCharacters.add(name);
    this.idOf(name);
    this.#profiles.set(name.toLowerCase(), seed);
  }

  /** Kink map (kink id → choice) for FKS matching; empty when unseeded. */
  kinksOf(name: string): Readonly<Record<string, string>> {
    const known = this.#findKnown(name);
    if (!known) {
      return {};
    }
    return this.#profiles.get(known.toLowerCase())?.kinks ?? {};
  }

  setGuestbook(name: string, posts: readonly SimGuestbookPostSeed[]): void {
    this.idOf(name);
    this.#guestbooks.set(name.toLowerCase(), [...posts]);
  }

  setMemo(account: string, character: string, note: string): void {
    this.#memos.set(`${account}\u0000${character.toLowerCase()}`, note);
  }

  setEiconIndex(names: readonly string[], asOf = DEFAULT_AS_OF): void {
    this.#eicons = [...names];
    this.#eiconAsOf = asOf;
    this.#eiconDeltas = [];
  }

  addEiconDelta(action: "+" | "-", name: string, at: number): void {
    this.#eiconDeltas.push({ action, name, at });
  }

  #findKnown(name: string): string | undefined {
    const lower = name.toLowerCase();
    for (const known of this.#knownCharacters) {
      if (known.toLowerCase() === lower) {
        return known;
      }
    }
    return undefined;
  }

  /** character-data.php — default profile for known characters, deepened by
   * setProfile. Failure mirrors the live error envelope. */
  characterData(name: string): object {
    const known = this.#findKnown(name);
    if (!known) {
      return { error: "Character not found." };
    }
    const seed = this.#profiles.get(known.toLowerCase()) ?? {};
    const npc = this.#npcByName.get(known);
    const settings = {
      customs_first: seed.settings?.customsFirst ?? true,
      show_friends: seed.settings?.showFriends ?? true,
      guestbook:
        seed.settings?.guestbook ?? this.#guestbooks.has(known.toLowerCase()),
      prevent_bookmarks: seed.settings?.preventBookmarks ?? false,
      public: seed.settings?.public ?? true,
    };
    const genderItem = LIST_FAMILIES[0]!.values.indexOf(npc?.gender ?? "");
    const defaultInfotags: Record<string, string> =
      genderItem >= 0
        ? { "3": String(this.#listitemId("gender", genderItem)) }
        : {};
    return {
      id: this.idOf(known),
      name: known,
      description:
        seed.description ?? `[b]${known}[/b] — a sim fixture character.`,
      views: seed.views ?? 1,
      customs_first: settings.customs_first,
      custom_title: seed.customTitle ?? "",
      is_self: false,
      settings,
      badges: [],
      created_at: seed.createdAt ?? DEFAULT_AS_OF - 86_400,
      updated_at: seed.updatedAt ?? DEFAULT_AS_OF,
      kinks: { ...(seed.kinks ?? {}) },
      custom_kinks: Object.fromEntries(
        Object.entries(seed.customKinks ?? {}).map(([id, custom]) => [
          id,
          {
            name: custom.name,
            description: custom.description ?? "",
            choice: custom.choice ?? "yes",
            children: [...(custom.children ?? [])],
          },
        ]),
      ),
      infotags: { ...defaultInfotags, ...(seed.infotags ?? {}) },
      // Live quirk: inline nyan/flags are string-typed on the wire too.
      inlines: Object.fromEntries(
        Object.entries(seed.inlines ?? {}).map(([id, inline]) => [
          id,
          {
            hash: inline.hash,
            extension: inline.extension,
            nyan: String(inline.nyan ?? 0),
          },
        ]),
      ),
      // Live quirk: character-data image values are strings, no URL.
      images: (seed.images ?? []).map((image, index) => ({
        image_id: String(image.id),
        extension: image.extension,
        height: String(image.height ?? 100),
        width: String(image.width ?? 100),
        description: image.description ?? "",
        sort_order: String(index),
      })),
      timezone: 0,
      current_user: { inline_mode: 0, animated_icons: true },
      error: "",
    };
  }

  /** character-guestbook.php — 0-based page, pages of 10. */
  guestbook(id: number, page: number): object {
    const lower = [...this.#idByLower.entries()].find(
      ([, value]) => value === id,
    )?.[0];
    const posts = lower ? this.#guestbooks.get(lower) : undefined;
    if (!posts) {
      return { error: "This character does not have a guestbook." };
    }
    const start = page * 10;
    const slice = posts.slice(start, start + 10);
    return {
      posts: slice.map((post, index) => ({
        id: start + index + 1,
        character: {
          id: this.idOf(post.from),
          name: post.from,
        },
        postedAt: post.postedAt ?? DEFAULT_AS_OF,
        message: post.message,
        reply: post.reply ?? null,
        private: post.private ?? false,
        approved: true,
        canEdit: false,
      })),
      page,
      canEdit: false,
      nextPage: posts.length > start + 10,
      error: "",
    };
  }

  /** character-memo-get2.php — target is the character NAME; an id-shaped
   * target misses, like the real endpoint. */
  memoGet(account: string, target: string): object {
    const known = this.#findKnown(target);
    if (!known) {
      return { error: "Character not found." };
    }
    const note = this.#memos.get(`${account}\u0000${known.toLowerCase()}`);
    return { note: note ?? null, id: this.idOf(known), error: "" };
  }

  #listitemId(family: string, indexInFamily: number): number {
    let id = 1;
    for (const entry of LIST_FAMILIES) {
      if (entry.family === family) {
        return id + indexInFamily;
      }
      id += entry.values.length;
    }
    throw new Error(`fchat-sim: unknown listitem family ${family}`);
  }

  /** mapping-list.php — every value string-typed, like the live payload. */
  mappingList(): object {
    let listitemId = 0;
    const listitems = LIST_FAMILIES.flatMap((entry) =>
      entry.values.map((value) => ({
        id: String((listitemId += 1)),
        name: entry.family,
        value,
      })),
    );
    return {
      kinks: KINKS.map((kink) => ({
        id: String(kink.id),
        name: kink.name,
        description: kink.description,
        group_id: String(kink.groupId),
      })),
      kink_groups: KINK_GROUPS.map((group) => ({
        id: String(group.id),
        name: group.name,
      })),
      infotags: INFOTAGS.map((tag) => ({
        id: String(tag.id),
        name: tag.name,
        type: tag.type,
        list: tag.list,
        group_id: String(tag.groupId),
      })),
      infotag_groups: INFOTAG_GROUPS.map((group) => ({
        id: String(group.id),
        name: group.name,
      })),
      listitems,
      error: "",
    };
  }

  /** kink-list.php — grouped, numeric ids (the live payloads disagree on
   * typing across endpoints; the sim preserves that). */
  kinkList(): object {
    return {
      kinks: Object.fromEntries(
        KINK_GROUPS.map((group) => [
          String(group.id),
          {
            group: group.name,
            items: KINKS.filter((kink) => kink.groupId === group.id).map(
              (kink) => ({
                kink_id: kink.id,
                name: kink.name,
                description: kink.description,
              }),
            ),
          },
        ]),
      ),
      error: "",
    };
  }

  /** info-list.php — grouped infotags; dropdowns carry their option list. */
  infoList(): object {
    return {
      info: Object.fromEntries(
        INFOTAG_GROUPS.map((group) => [
          String(group.id),
          {
            group: group.name,
            items: INFOTAGS.filter((tag) => tag.groupId === group.id).map(
              (tag) => ({
                id: tag.id,
                name: tag.name,
                type: tag.type,
                ...(tag.type === "list"
                  ? {
                      list: LIST_FAMILIES.find(
                        (entry) => entry.family === tag.list,
                      )?.values,
                    }
                  : {}),
              }),
            ),
          },
        ]),
      ),
      error: "",
    };
  }

  /** EiconsDataBase/base.doc — `name\thash` lines with an As Of comment. */
  eiconBaseDoc(): string {
    const lines = this.#eicons.map(
      (name) => `${name}\tsimhash-${name.length.toString(16)}`,
    );
    return [`# As Of: ${String(this.#eiconAsOf)}`, ...lines, ""].join("\n");
  }

  /** EiconsDataDeltaSince/<ts> — `+|-\tname` lines with an As Of comment. */
  eiconDeltaSince(since: number): string {
    const deltas = this.#eiconDeltas.filter((delta) => delta.at > since);
    const asOf = this.#eiconDeltas.reduce(
      (max, delta) => Math.max(max, delta.at),
      this.#eiconAsOf,
    );
    const lines = deltas.map((delta) => `${delta.action}\t${delta.name}`);
    return [`# As Of: ${String(asOf)}`, ...lines, ""].join("\n");
  }
}
