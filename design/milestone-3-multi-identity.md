# Milestone 3 — Multi-Identity

**Goal:** multiple F-List character identities connected concurrently, switched via the far-left identity rail; switching swaps the *entire* session context (sidebar, DMs, presence, roles, log) — the load-bearing IA decision from the design files.

**Depends on:** Milestone 2 (sessions must already be server-owned and durable).

## Scope

- **IdentityRail** per `ui/COMPONENTS.md` §1: active identity squared-off with accent bar, inactive circles, presence dots, unread/mention badges for background identities, `+` add button. Avatars are real F-List profile images with initial-on-color fallback (decisions.md §6).
- Multiple concurrent `FchatSession`s per user; identities on the same F-List account share the per-account TicketManager (ticket coalescing is what makes this safe — see `architecture.md`).
- Full context swap in the client: `stores/sessions.ts` holds a `Map<identityId, IdentitySession>`; the rail changes the active key, everything re-renders from that slice.
- Per-identity **ignore lists** wired to the F-Chat `IGN` command (init/add/delete) and the `ignores` table; ignored characters' messages hidden client-side (protocol note: ignoring is the client's responsibility; send `IGN notify` when receiving an ignored PRI).
- Rail right-click menu: set status / reconnect / disconnect / reorder (persisted `sort_order`).
- Background-identity badge aggregation (unread count, `@n` mentions) in `ready`/`snapshot` payloads.
- **Human-readable URLs** (M1 UAT request, Discord-inspired): replace `/app/<identityId-uuid>/<convId-uuid>` with the identity as the first path segment — the analog of Discord's `@me` slot, per the multi-identity IA. F-List character names are globally unique, so names are the natural keys throughout: `/app/Kara%20Eressea/c/Frontpage` (channels by name, private rooms by their stable `ADH-` id), `/app/Kara%20Eressea/dm/Eressea` (DMs by partner). Resolution is case-insensitive (F-Chat semantics; F-List's own `/c/<name>` profile URLs are precedent for encoded spaces), canonical casing restored on load. Optional `@me` alias redirecting to the last-active identity, so bookmarks can stay identity-agnostic. Old UUID routes keep working as redirects. Finalize the exact shape when the rail lands.

## Verification

- Integration: two identities on one F-List account connect simultaneously → exactly one ticket fetch (coalesced), both sessions online.
- E2E: switch identities via rail → sidebar, log, member list, me-bar all swap; background identity accumulates an unread badge while another is active.
- Unit: IGN state transitions; ignored sender's messages filtered from render but still persisted.
