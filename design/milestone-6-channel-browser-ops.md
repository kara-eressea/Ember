# Milestone 6 — Channel Browser + Channel Ops

**Goal:** channel discovery/joining per the Channel Browser design, plus RP-specific message types and the operator toolset (which also satisfies the developer policy's "rudimentary administration tools" item).

**Depends on:** Milestone 1 (session engine); benefits from Milestone 3 (roles per identity).

## Scope

- **Channel browser dialog** per `ui/COMPONENTS.md` §11: Official (`CHA`) and Open rooms (`ORS`) tabs with counts, filter-by-name-or-topic, state-aware Join / ✓ Joined / ⚲ Pinned buttons, and the footer **join-hidden-by-name** input (hidden/invite-only rooms use `ADH-…` ids and never appear in listings).
- `channel_directory` cache table refreshed on open (rate-limited; ORS counts are point-in-time — display staleness honestly).
- **Room creation:** `CCR` (private/invite-only rooms), `RST` open/closed toggle, `CIU` invites (render inbound invites as actionable rows).
- **RP message types:** `LRP` ads rendered distinctly and gated by room mode (`RMO` chat/ads/both); `RLL` dice/bottle rendering; `/roll` and `/bottle` composer commands. Respect lfrp_flood (1/10 min) in the rate-gate.
- **Op tooling**, gated by viewer role (owner ~ / channel op @ from `COL`, chatop from `ADL`): kick `CKU`, ban/unban `CBU`/`CUB`, timeout `CTU`, promote/demote `COA`/`COR`, set owner `CSO`, room mode `RMO`, topic/description `CDS`. Surface via MemberContextMenu admin section + composer slash-commands. Ban list via `CBL` (arrives as SYS — parse defensively).
- Channel invite, kick, ban events rendered as SystemLines.
- **Social actions from the MemberContextMenu** — add/remove bookmark and send/accept/cancel friend requests via the F-List JSON API (`bookmark-add/remove`, `request-*` endpoints), respecting the API budget; sidebar Friends/Bookmarks sections refresh from FRL + API.
- **Feature-parity audit** against the official chat3client (see `milestones.md` standing to-dos) — decide fate of FKS character search, RTB note notifications, and anything else it surfaces.

## Verification

- Sim: CHA/ORS fixtures, role assignment, op command echoes, SYS-response parsing for CBL/COL.
- Integration: join-by-ADH-id round-trip; RMO gates which message kinds the composer offers.
- E2E: browse → join → appears in sidebar; as op, kick a user → member list updates and SystemLine renders; non-ops never see admin menu items.
