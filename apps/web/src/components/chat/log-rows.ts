// Pure row-model builder for the MessageLog: date dividers, the
// "new since last visit" divider, message rows, live-only presence lines.

import type { MessageDto } from "@emberchat/protocol";
import { dayKey, dayLabel } from "../../lib/time.js";
import type { PresenceLine } from "../../stores/messages.js";

export type LogRow =
  | { type: "divider"; key: string; label: string }
  | { type: "new"; key: string }
  | { type: "presence"; key: string; line: PresenceLine }
  | {
      type: "message";
      key: string;
      message: MessageDto;
      /** Group-consecutive pref: this row continues the sender above it —
       * the renderer drops the nick. */
      grouped?: boolean;
    };

/** Group-consecutive window: a gap longer than this starts a fresh group. */
export const GROUP_WINDOW_MS = 5 * 60_000;

/**
 * `newSinceId` is the read cursor frozen at attach time — the "new" divider
 * sits above the first inbound message past it and stays put while the live
 * cursor advances underneath (the component remounts per conversation, so
 * revisiting recomputes it). Own sends never count as new: the divider skips
 * past them to the first message worth reading, and never renders at all
 * when everything new is ours. `null` cursor = nothing was ever read; the
 * whole log is "new", which is exactly when a divider says nothing.
 */
export function buildRows(
  messages: MessageDto[],
  newSinceId: number | null,
  ignores: readonly string[] = [],
  options: {
    groupConsecutive?: boolean;
    /** Live-only join/part/quit lines, merged by timestamp (the show-
     * join/part/quit pref: the caller passes nothing when it's off). */
    presence?: readonly PresenceLine[];
  } = {},
): LogRow[] {
  // Ignoring is render-side only (messages stay persisted; unignoring later
  // brings them back). Own sends always show; names match case-insensitively.
  const ignored = new Set(ignores.map((name) => name.toLowerCase()));
  const visible =
    ignored.size === 0
      ? messages
      : messages.filter(
          (message) =>
            message.sentByUs ||
            !ignored.has(message.senderCharacter.toLowerCase()),
        );
  const presence = (options.presence ?? []).filter(
    (line) => !ignored.has(line.character.toLowerCase()),
  );
  let presenceIndex = 0;
  const rows: LogRow[] = [];
  let lastDay: string | undefined;
  let newMarked = newSinceId === null;
  /** The message a grouped row would continue; reset by any other row. */
  let groupHead: MessageDto | undefined;
  const flushPresenceBefore = (isoOrEnd?: string) => {
    while (
      presenceIndex < presence.length &&
      (isoOrEnd === undefined || presence[presenceIndex]!.createdAt <= isoOrEnd)
    ) {
      const line = presence[presenceIndex]!;
      rows.push({ type: "presence", key: line.key, line });
      presenceIndex += 1;
      groupHead = undefined;
    }
  };
  for (const message of visible) {
    flushPresenceBefore(message.createdAt);
    const day = dayKey(message.createdAt);
    if (day !== lastDay) {
      rows.push({
        type: "divider",
        key: `d:${day}`,
        label: dayLabel(message.createdAt),
      });
      lastDay = day;
      groupHead = undefined;
    }
    if (!newMarked && message.id > newSinceId! && !message.sentByUs) {
      rows.push({ type: "new", key: "new" });
      newMarked = true;
      groupHead = undefined;
    }
    // Emotes never group (the nick is part of the sentence) and never
    // continue a group; sys lines have no sender at all.
    const groupable =
      options.groupConsecutive === true &&
      message.kind !== "sys" &&
      !message.bbcode.startsWith("/me");
    const grouped =
      groupable &&
      groupHead !== undefined &&
      groupHead.senderCharacter === message.senderCharacter &&
      groupHead.sentByUs === message.sentByUs &&
      Date.parse(message.createdAt) - Date.parse(groupHead.createdAt) <=
        GROUP_WINDOW_MS;
    rows.push({
      type: "message",
      key: `m:${String(message.id)}`,
      message,
      ...(grouped ? { grouped } : {}),
    });
    groupHead = groupable ? message : undefined;
  }
  // Lines newer than the newest message (the common case: they just happened).
  flushPresenceBefore(undefined);
  return rows;
}
