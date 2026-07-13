# Milestone 4 — Markdown Layer + Delayed Send

**Goal:** compose in Markdown, send well-structured BBCode; "edit" messages by holding them in a server-side outbox for a configurable delay, recallable with ArrowUp.

**Depends on:** Milestone 1 (composer, session engine, gateway). Independent of Milestone 3 — can run in parallel with it.

## Scope

- **`packages/markdown-bbcode` completed** against exactly the F-Chat tag subset (`b i u s sup sub color url user icon eicon noparse` — see `chat-bbcode-tags.md`). `mdToBBCode()` must never emit a tag outside the subset (developer-policy requirement); `sanitize()` strips anything else from inbound content before rendering.
- **Composer live Markdown preview** per `ui/COMPONENTS.md` §7–8: preview panel above the input rendering through the same tokenizer/component pipeline as the message log; Markdown toggle; Enter to send / Shift+Enter newline.
- **Inline eicon/icon rendering** (decisions.md §8): `[eicon]`/`[icon]` in messages and preview render as inline images at a fixed ~60px box with explicit dimensions (stable virtualized rows), lazy-loaded. `[eicon]name[/eicon]` typed literally passes through the Markdown layer untouched; the composer ☺ button is an insert-by-name helper; composer warns in `icon_blacklist` channels.
- **BBCode rendering everywhere it arrives, not just message bodies**: channel descriptions/topics (CDS — the ChannelHeader description row shows raw `[b]…[/b]` today, spotted in M1 UAT), status messages, and later surfaces all render through the same sanitize → tokenizer → component pipeline as the log.
- **Slash commands + emote rendering** (M1 UAT finding): `/me` at minimum — on the wire it is just a message starting with `/me ` (passthrough already works), but the composer should recognize it and the log must render emotes as the official client does (italic, `Name does something`, no nick separator); same for received emotes. Enumerate the rest of chat3client's slash commands in the feature-parity audit (M6 standing to-do) and decide which land here vs. later.
- **Delayed send (server-side outbox):** `msg.send` writes to `outbox_messages` with `release_at = now + delay` (per-user preference, 0 = immediate). A release worker translates MD→BBCode and hands it to the session's rate-gate at release time. Living server-side means closing the tab doesn't lose or prematurely flush the queue.
- **ArrowUp recall:** within the delay window, ArrowUp issues `outbox.recall` → the pending message returns to the composer for editing; the outbox row is cancelled. Gateway events keep all attached devices' composers/pending indicators in sync.
- Pending messages render in the log immediately with a "sending in Ns" affordance (local echo reconciled when the released message round-trips).
- **TPN typing indicators** both directions for PMs.

## Verification

- Unit (property-style): for arbitrary Markdown input, every tag in `mdToBBCode()` output ∈ allowed subset; BBCode→AST→BBCode round-trips the subset.
- Integration: outbox release ordering respects msg_flood; recall cancels before release; server restart mid-delay → outbox rows survive and release on schedule.
- E2E: type → preview matches final render; send with 10s delay → ArrowUp recalls to composer; close tab mid-delay → message still sends.
- E2E: message containing `[eicon]` renders the image inline at fixed size; scrolling a log with eicons doesn't jump as images load.
