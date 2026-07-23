// The fake world the sim serves: accounts, channels, and NPC characters that
// are "online" without a socket behind them. Everything here is fixture data
// — never real F-List credentials.

import type { ChannelMode } from "@emberchat/fchat-protocol";

export interface SimAccount {
  readonly password: string;
  readonly characters: readonly string[];
  /** Account-wide profile bookmarks (JSON API + FRL seed). */
  readonly bookmarks?: readonly string[];
  /** Friend pairs: `own` is this account's character, `friend` theirs. */
  readonly friends?: readonly { own: string; friend: string }[];
  /** Incoming friend requests waiting on this account (request-list). */
  readonly incomingRequests?: readonly { from: string; to: string }[];
}

export interface SimChannelSeed {
  /** Channel name (official) or ADH- ID (private room). */
  readonly name: string;
  /** Display title for private rooms; official channels use the name. */
  readonly title?: string;
  readonly mode: ChannelMode;
  readonly description: string;
  /** Channel ops; first entry is the owner ("" for unowned official channels). */
  readonly oplist?: readonly string[];
  /** NPCs seeded as members. */
  readonly npcs?: readonly string[];
  /** false = hidden/invite-only room: joinable by exact name but never
   * returned in ORS listings (real ADH- rooms behave this way when closed).
   * Official channels are always listed. */
  readonly listed?: boolean;
}

export interface SimNpc {
  readonly name: string;
  readonly gender: string;
  readonly status: string;
  readonly statusmsg: string;
  /** Optional profile-image seeds surfaced through character-data (the
   * Images tab / lightbox). Omitted for NPCs whose profile has no gallery. */
  readonly images?: readonly {
    readonly id: number;
    readonly extension: string;
    readonly height?: number;
    readonly width?: number;
    readonly description?: string;
  }[];
  /** Overrides the generated default description — used to embed profile
   * BBCode (e.g. an inline [img]) the renderer must handle. */
  readonly description?: string;
  /** Optional inline-image seeds (character-data `inlines`): [img]id[/img] in
   * the description resolves against these by id. */
  readonly inlines?: readonly {
    readonly id: number;
    readonly hash: string;
    readonly extension: string;
  }[];
}

export interface SimWorld {
  readonly accounts: Readonly<Record<string, SimAccount>>;
  readonly channels: readonly SimChannelSeed[];
  readonly npcs: readonly SimNpc[];
  /** Chatops (global moderators) announced via ADL at login. None by
   * default — tests that need one build a world with it. */
  readonly chatops?: readonly string[];
}

export const DEFAULT_WORLD: SimWorld = {
  accounts: {
    // amber is shared by unit/integration suites (each runs its own sim);
    // within the E2E suite it belongs to chat.spec alone — sharing an
    // ACCOUNT between parallel specs makes their ticket managers invalidate
    // each other (every new ticket kills all previous ones account-wide).
    "amber@example.test": {
      password: "hunter2",
      characters: ["Amber Vale", "Cindral"],
    },
    // Reserved for the scrollback rubberband E2E (#360): a channel the
    // browser character reads while a raw-SimClient partner pumps history in.
    "peat@example.test": {
      password: "hunter2",
      characters: ["Peat Hollow", "Reed Hollow"],
    },
    // Reserved for the message-log tail/unread-marker E2E (#372/#373): the
    // browser reads channels and a DM while Wick Marsh (a raw SimClient) pumps
    // variable-height history in. Own account so parallel specs never share a
    // ticket manager.
    "quill@example.test": {
      password: "hunter2",
      characters: ["Quill Marsh", "Wick Marsh"],
    },
    // Reserved for the auth E2E (account-add/identity CRUD flows).
    "aspen@example.test": {
      password: "hunter2",
      characters: ["Aspen Vale", "Aspen Brook"],
    },
    "birch@example.test": {
      password: "hunter2",
      characters: ["Birch Rowan"],
    },
    // Reserved for the M2 bouncer E2E — spec files run in parallel and a
    // character can hold only one sim connection, so specs never share one.
    "willow@example.test": {
      password: "hunter2",
      characters: ["Willow Reed", "Fern Ashwood"],
    },
    // Reserved for the M3 multi-identity rail E2E (same parallelism rule);
    // Bramble is its raw-SimClient "other side".
    "rowan@example.test": {
      password: "hunter2",
      characters: ["Rowan Redleaf", "Petal Thorn"],
    },
    "thorn@example.test": {
      password: "hunter2",
      characters: ["Bramble Thorn"],
    },
    // Reserved for the M4 compose/delayed-send E2E (same parallelism rule).
    "sage@example.test": {
      password: "hunter2",
      characters: ["Sage Willowmere"],
    },
    // Reserved for the M5 preferences E2E (same parallelism rule);
    // Fenwick Sprout is its raw-SimClient "other side".
    "hazel@example.test": {
      password: "hunter2",
      characters: ["Hazel Fenwick", "Fenwick Sprout"],
    },
    // Reserved for the M6 channel-browser E2E (same parallelism rule);
    // Quince Pip is its raw-SimClient "other side" (room owner, inviter).
    "laurel@example.test": {
      password: "hunter2",
      characters: ["Laurel Quince", "Quince Pip"],
    },
    // Reserved for the M6 RP-messages E2E (same parallelism rule); Moss
    // Tinker is its raw-SimClient "other side" (Greenhouse op, ad sender).
    "ivy@example.test": {
      password: "hunter2",
      characters: ["Ivy Bramblewood", "Moss Tinker"],
    },
    // Reserved for the M10 ads+search E2E (same parallelism rule); Kolvarr
    // is its raw-SimClient "other side" (Aurora Den op, search target).
    "vesna@example.test": {
      password: "hunter2",
      characters: ["Vesna Marlowe", "Kolvarr"],
    },
    // Reserved for the M11 campaigns+ratings E2E (same parallelism rule);
    // Orsolya is its raw-SimClient "other side" (Borealis Lounge op, the
    // rated ad poster).
    "linden@example.test": {
      password: "hunter2",
      characters: ["Linden Frost", "Orsolya"],
    },
    // Reserved for the M6 op-tooling E2E (same parallelism rule); Alder Fen
    // (Potting Shed owner) and Sorrel Vane (moderation target) are its
    // raw-SimClient "other sides".
    "rue@example.test": {
      password: "hunter2",
      characters: ["Rue Alder", "Alder Fen", "Sorrel Vane"],
    },
    // Reserved for the #200 seen-recently E2E (same parallelism rule);
    // Dell Marsh is its raw-SimClient "other side" (joins, then parts).
    "clover@example.test": {
      password: "hunter2",
      characters: ["Clover Hart", "Dell Marsh"],
    },
    // Reserved for the history catch-up E2E (#254, same parallelism rule);
    // Coal Whitby is its raw-SimClient "other side" (the DM partner whose
    // messages pile up while the browser is detached).
    "ember@example.test": {
      password: "hunter2",
      characters: ["Ember Hollis", "Coal Whitby"],
    },
    // Reserved for the inline-composer E2E (#226, same parallelism rule).
    "tansy@example.test": {
      password: "hunter2",
      characters: ["Tansy Meridian"],
    },
    // Reserved for the #284 background-scroll E2E (same parallelism rule);
    // Wren Salloway is its raw-SimClient "other side" (the message sender
    // while the profile modal obscures the log).
    "marigold@example.test": {
      password: "hunter2",
      characters: ["Marigold Bell", "Wren Salloway"],
    },
    // Reserved for the M8 profile E2E (same parallelism rule).
    "juniper@example.test": {
      password: "hunter2",
      characters: ["Juniper Wren"],
    },
    // Reserved for the #170 DM mini-profile sidebar E2E (same parallelism
    // rule); Bramble Fen is its raw-SimClient "other side" (the PM sender,
    // whose profile is seeded so the sidebar's note + match load).
    "thistle@example.test": {
      password: "hunter2",
      characters: ["Thistle Vane", "Bramble Fen"],
    },
    // Reserved for the #315 "Mark as read" E2E (same parallelism rule);
    // Cress Dell is its raw-SimClient "other side" (the DM sender whose
    // unread badge is cleared from the sidebar context menu).
    "bracken@example.test": {
      password: "hunter2",
      characters: ["Bracken Vale", "Cress Dell"],
    },
    // Reserved for the M6 social E2E (same parallelism rule). Fern arrives
    // with a bookmark, a friend, and a pending incoming request from Tally.
    "fern@example.test": {
      password: "hunter2",
      characters: ["Fern Glade"],
      bookmarks: ["Old Greywhisker"],
      friends: [{ own: "Fern Glade", friend: "Nyx Firemane" }],
      incomingRequests: [{ from: "Tally Marsh", to: "Fern Glade" }],
    },
    // Reserved for the #316 "Invite to →" E2E (same parallelism rule). Briar
    // Vale owns the private Invite Harbor; Nettle Fen is the raw-SimClient
    // invitee (met in a public room). Nettle gets her own account so her
    // connection is never disturbed by Briar's account-wide ticket churn —
    // the receiving side needs a stable connection (cf. chat.spec's Birch).
    "briar@example.test": {
      password: "hunter2",
      characters: ["Briar Vale"],
    },
    "nettle@example.test": {
      password: "hunter2",
      characters: ["Nettle Fen"],
    },
    // Reserved for the #329 sidebar offline-filtering E2E (same parallelism
    // rule). Two characters on one account so the partner is a raw SimClient
    // whose presence (online → FLN offline) the browser identity observes,
    // exactly like catchup.spec's Ember/Coal pair. Sorrel drives the
    // header-toggle case, Bramble the detach → reattach unread case.
    "sorrel@example.test": {
      password: "hunter2",
      characters: ["Sorrel Ash", "Dusk Wren"],
    },
    "bramble@example.test": {
      password: "hunter2",
      characters: ["Bramble Fen", "Moss Dell"],
    },
    // Reserved for the #327 dead-private-room E2E (same parallelism rule).
    // Cinder Ash is the browser user; Vault Keeper is a raw-SimClient owner
    // who invites, kicks, then leaves an ADH- room she creates so it is
    // reaped mid-test — reproducing the "room destroyed while we thought we
    // held it" ghost without a bouncer restart.
    "cinder@example.test": {
      password: "hunter2",
      characters: ["Cinder Ash"],
    },
    "vault@example.test": {
      password: "hunter2",
      characters: ["Vault Keeper"],
    },
    // Reserved for the #336 typing-indicator-placement E2E (same parallelism
    // rule). Two characters on one account so the partner is a raw SimClient:
    // Rowan Birch pushes TPN states the browser identity (Yarrow Dale) sees on
    // the message bar.
    "yarrow@example.test": {
      password: "hunter2",
      characters: ["Yarrow Dale", "Rowan Birch"],
    },
    // Reserved for the #346 identity-rail-toggle E2E (same parallelism rule).
    // Two characters on one account: the browser connects Tamarisk Ash alone,
    // hides the rail via the avatar, then connects Marsh Willow from the
    // picker — a second identity that forces the hidden rail back into view.
    "tamarisk@example.test": {
      password: "hunter2",
      characters: ["Tamarisk Ash", "Marsh Willow"],
    },
  },
  channels: [
    {
      name: "Frontpage",
      mode: "chat",
      description: "The sim's default hangout. [b]Be nice.[/b]",
      oplist: ["", "Nyx Firemane"],
      npcs: ["Nyx Firemane", "Tally Marsh", "Old Greywhisker"],
    },
    {
      name: "Development",
      mode: "both",
      description: "Talk about third-party clients here.",
      npcs: ["Tally Marsh"],
    },
    // Reserved for the rail E2E: chat.spec asserts exact Frontpage member
    // counts, so parallel specs must not wander in — channel isolation
    // follows the same rule as character isolation.
    {
      name: "Gardening",
      mode: "chat",
      description: "Seeds, cuttings, and quiet company.",
      npcs: ["Tally Marsh"],
    },
    // Reserved for the M5 preferences E2E (join/part/quit lines).
    {
      name: "Terrarium",
      mode: "both",
      description: "Small glass worlds.",
      npcs: [],
    },
    {
      name: "ADH-1a2b3c4d5e6f7a8b9c0d",
      title: "Ember Lounge",
      mode: "both",
      description: "A private open room with an [i]ID[/i] instead of a name.",
      oplist: ["Nyx Firemane"],
      npcs: ["Nyx Firemane"],
    },
    // Reserved for the M6 channel-browser E2E (join through the dialog).
    {
      name: "Orchard",
      mode: "chat",
      description: "Rows of quiet trees.",
      npcs: ["Tally Marsh"],
    },
    // Hidden room for the browser's join-by-name footer: joinable by exact
    // id, never listed in ORS.
    {
      name: "ADH-9f8e7d6c5b4a39281706",
      title: "Root Cellar",
      mode: "chat",
      description: "You had to be told about this place.",
      oplist: ["Nyx Firemane"],
      npcs: ["Nyx Firemane"],
      listed: false,
    },
    // Reserved for the M6 RP-messages E2E: mode "both" so ads and the
    // composer's Ad toggle are live; hidden so listing counts elsewhere
    // stay stable; no NPCs so /bottle is deterministic.
    {
      name: "ADH-77aa88bb99cc00dd11ee",
      title: "Greenhouse",
      mode: "both",
      description: "Warm glass and growing things.",
      oplist: ["Moss Tinker"],
      npcs: [],
      listed: false,
    },
    // Reserved for the M10 ads+search E2E: a "both"-mode room with the
    // community [ads: N min] cadence token in its description. Hidden and
    // NPC-free for the same isolation reasons as the Greenhouse.
    {
      name: "ADH-m10aurora00dd11ee22ff",
      title: "Aurora Den",
      mode: "both",
      description: "Snowed-in scenes under green light. [ads: 15 min] please.",
      oplist: ["Kolvarr"],
      npcs: [],
      listed: false,
    },
    // Reserved for the M11 campaigns+ratings E2E: two "both"-mode rooms —
    // the campaign rotates into both; a manual post closes Borealis's ad
    // window first so the campaign's attempt there pauses visibly while
    // Polar Court takes a real rotation post. Hidden and NPC-free for the
    // usual isolation.
    {
      name: "ADH-m11borealis33aa44bb",
      title: "Borealis Lounge",
      mode: "both",
      description: "Green skies, low fires.",
      oplist: ["Orsolya"],
      npcs: [],
      listed: false,
    },
    {
      name: "ADH-m11polar55cc66dd77",
      title: "Polar Court",
      mode: "both",
      description: "Ice pillars and patient company.",
      oplist: ["Orsolya"],
      npcs: [],
      listed: false,
    },
    // Reserved for the M6 op-tooling E2E: Alder Fen owns it; Rue Alder
    // starts as a plain member (the spec promotes her live). Hidden for the
    // same listing-stability reason.
    {
      name: "ADH-55ee66ff77aa88bb99cc",
      title: "Potting Shed",
      mode: "chat",
      description: "Tools on every wall.",
      oplist: ["Alder Fen"],
      npcs: [],
      listed: false,
    },
    // Reserved for the M8 profile E2E: NPC members whose profiles the spec
    // views. Hidden for the same listing-stability reason.
    {
      name: "ADH-22bb33cc44dd55ee66ff",
      title: "Reading Nook",
      mode: "chat",
      description: "Shelves, lamplight, and low voices.",
      oplist: ["Nyx Firemane"],
      npcs: ["Tally Marsh", "Old Greywhisker"],
      listed: false,
    },
    // Reserved for the #284 background-scroll E2E: Wren Salloway sends
    // messages while the profile modal is open. Hidden and NPC-free for
    // the usual isolation reasons.
    {
      name: "ADH-284sunporch11aa22bb",
      title: "Sun Porch",
      mode: "chat",
      description: "Warm light through old glass.",
      oplist: ["Wren Salloway"],
      npcs: [],
      listed: false,
    },
    // Reserved for the #372 message-log tail E2E (messagelog-tail.spec): Quill
    // Marsh switches between two fully-read rooms while Wick Marsh pumps
    // variable-height history in. Hidden and NPC-free for isolation.
    {
      name: "ADH-372taila11bb22cc33",
      title: "Tail Room A",
      mode: "chat",
      description: "First of the switch pair.",
      oplist: ["Wick Marsh"],
      npcs: [],
      listed: false,
    },
    {
      name: "ADH-372tailb44dd55ee66",
      title: "Tail Room B",
      mode: "chat",
      description: "Second of the switch pair.",
      oplist: ["Wick Marsh"],
      npcs: [],
      listed: false,
    },
    // Reserved for the #200 seen-recently E2E: Dell Marsh joins and parts
    // live. Hidden and NPC-free for the usual isolation reasons.
    {
      name: "ADH-200fallow88ee99ff00",
      title: "Fallow Field",
      mode: "chat",
      description: "Resting ground between seasons.",
      oplist: ["Dell Marsh"],
      npcs: [],
      listed: false,
    },
    // Reserved for the #268 combined-reattach E2E (catchup.spec): Ember
    // Hollis sits here while Coal Whitby joins, parts during a detach (seen
    // fold), and rejoins live. Hidden and NPC-free for isolation.
    {
      name: "ADH-268catchupdd44ee55ff66",
      title: "Ember Catchup",
      mode: "chat",
      description: "Where the waves catch up.",
      oplist: ["Ember Hollis"],
      npcs: [],
      listed: false,
    },
    // Reserved for the #360 scrollback rubberband E2E (scrollback.spec): Peat
    // Hollis reads while Reed Hollow pumps a long history in. Hidden and
    // NPC-free for isolation.
    {
      name: "ADH-360scrollbackaa11bb22cc33",
      title: "Peat Scrollback",
      mode: "chat",
      description: "A deep spool of history.",
      oplist: ["Peat Hollow"],
      npcs: [],
      listed: false,
    },
    // Reserved for the M6 social E2E: NPC members to right-click. Hidden
    // for the same listing-stability reason.
    {
      name: "ADH-33cc44dd55ee66ff77aa",
      title: "Fernery",
      mode: "chat",
      description: "Fronds everywhere.",
      oplist: ["Nyx Firemane"],
      npcs: ["Tally Marsh", "Old Greywhisker"],
      listed: false,
    },
    // Reserved for the #316 "Invite to →" E2E: Briar Vale's private room.
    // Hidden (never listed in ORS); Briar reaches it by exact id.
    {
      name: "ADH-316inviteharbor00aa11bb",
      title: "Invite Harbor",
      mode: "chat",
      description: "Members by invitation.",
      oplist: ["Briar Vale"],
      listed: false,
    },
    // Reserved for the #351 rail-toggle-layout E2E: a channel with an NPC so
    // the member list track has content, letting the spec assert the shell
    // grid keeps its columns (sidebar / chat / members) when the rail hides.
    // Hidden and single-NPC for the usual isolation reasons.
    {
      name: "ADH-351railshed99aa88bb77",
      title: "Trellis Shed",
      mode: "chat",
      description: "Where the shape of things is checked.",
      oplist: ["Nyx Firemane"],
      npcs: ["Tally Marsh"],
      listed: false,
    },
  ],
  npcs: [
    { name: "Nyx Firemane", gender: "Female", status: "online", statusmsg: "" },
    {
      name: "Tally Marsh",
      gender: "Male",
      status: "looking",
      statusmsg: "Open for scenes!",
      // Profile description embeds an inline image via [img]id[/img] (#212):
      // the renderer resolves the id against `inlines` below.
      description:
        "[b]Tally Marsh[/b]\n[img]90101[/img]\nFound by the water most days.",
      inlines: [
        {
          id: 90_101,
          // Fixture hash — sharded into the charinline URL path; never real.
          hash: "abcdef0123456789",
          extension: "png",
        },
      ],
      // A small gallery so the profile E2E can exercise the Images tab and
      // the full-screen lightbox zoom (#236): one large portrait (zoom binds
      // on height and fills the viewport) and one tiny image (must never be
      // upscaled past its natural size).
      images: [
        {
          id: 90_001,
          extension: "png",
          width: 1200,
          height: 1600,
          description: "Reading by the window",
        },
        {
          id: 90_002,
          extension: "png",
          width: 300,
          height: 200,
          description: "By the river",
        },
      ],
    },
    {
      name: "Old Greywhisker",
      gender: "None",
      status: "busy",
      statusmsg: "Lurking.",
    },
  ],
};
