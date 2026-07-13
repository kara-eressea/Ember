# Handoff: EmberChat — IRC-style chat client

## Overview
EmberChat is a **browser-based, IRC-native chat client** that keeps a live session to a central server. It is channel-first (IRC-style, *not* Discord guilds), supports DMs, two tiers of people (Friends + Bookmarks), pinning/auto-rejoin for both channels and DMs, a roles-based member list, and live Markdown preview while composing.

A distinguishing detail: there are **two login layers** (F-Chat / F-List model):
1. **App account** — your EmberChat web login (username + email + password). Nothing to do with the server.
2. **Server identity** — after signing in, you *connect* one or more server identities ("characters"). Each connected identity is its own live session with its own presence, DMs, pinned channels and roles. Multiple identities are switched via a **far-left identity rail**.

## About the design files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy directly**. They are authored as "Design Components" (a small custom `<x-dc>` runtime used by the design tool); do **not** try to reuse that runtime.

Your task is to **recreate these designs in the target codebase's environment** (React/Vue/Svelte/etc.) using its established patterns, component library and state management. If no environment exists yet, pick the most appropriate stack for a real-time chat client (a React + WebSocket setup is a natural fit) and implement there. Wire the UI to the real IRC-like server protocol; all data in the mocks is placeholder.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii and states are final and exact — see `COMPONENTS.md` for the token values and per-component specs. Recreate the UI to match, using your codebase's primitives. The one thing left open is your framework's real data binding and socket layer.

## The chosen visual direction
Of the directions explored, the selected theme is **"Slate Cozy / Dusk Purple"** — dark, warm, cozy, sans UI with a monospace message log and timestamps, ultra-compact IRC lines. The full palette + type system is in `COMPONENTS.md` → *Design Tokens*.

The client is **theme-able**: the same layout was proven against several accent colors (Amber, Clay Red, Dusk Purple, Burnt Orange, Moss Green). Build the accent as a swappable token from day one — the Appearance preferences pane exposes it to the user, and *every* accent variant stays available. Only the accent hue + the per-nick color palette change between accents; the neutrals stay fixed.

## What to read next
- **`COMPONENTS.md`** — the cheat sheet. Every component with its anatomy, exact tokens, states, data shape and behavior. This is the primary reference.
- The `.dc.html` files — open in a browser to see the live reference for each piece.

## Reference files in this bundle
| File | What it shows |
|---|---|
| `EmberChat Client.dc.html` | **The main client**, with the identity rail. Two states: work identity vs. social identity, proving the per-identity context swap. |
| `IRC Client Directions.dc.html` | The full client in the explored theme directions + accent variants (context menu, markdown preview, expanded description states). |
| `Multi-Identity.dc.html` | The two multi-identity patterns compared (identity rail vs. top tabs). Rail was chosen. |
| `Channel Browser.dc.html` | Channel browser dialog — Official / Open rooms tabs + join-hidden-by-name footer. |
| `Preferences.dc.html` | Preferences window — Appearance (incl. accent switcher), Highlights, Away & logs panes. |
| `Account Flow.dc.html` | Landing page, create-account, login, and connect-server-identity screens. |
| `ClientMock.dc.html` | Source of the reusable client shell (all sidebar/log/member/overlay markup + the exact style values). Best single place to read precise numbers. |

## Screens covered
1. **Landing page** — marketing entry (`Account Flow` card A)
2. **Create app account** / **Log in** (`Account Flow` cards B, C)
3. **Connect a server identity** — the second login (`Account Flow` card D)
4. **Main client** — rail + unified sidebar + IRC chat + member list (`EmberChat Client`)
5. **Channel browser** dialog
6. **Preferences** window
7. **Overlays** — member right-click context menu

See `COMPONENTS.md` for the component-by-component breakdown that composes these screens.
