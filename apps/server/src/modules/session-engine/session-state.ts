// In-memory roster for one F-Chat session: server vars, online characters,
// joined channels, own identity. Volatile by design — the gateway serves
// snapshots from here (architecture.md), while durable history goes through
// the event bus to the history sink.

import {
  applyVar,
  DEFAULT_SERVER_VARS,
  type ServerCommand,
  type ServerVars,
} from "@emberchat/fchat-protocol";

export type SessionStatus =
  | "idle"
  | "acquiring_ticket"
  | "connecting"
  | "identifying"
  | "online"
  | "backoff"
  | "stopped";

export interface CharacterPresence {
  gender: string;
  status: string;
  statusmsg: string;
}

export interface ChannelState {
  /** F-Chat channel key: public name or ADH-… id. */
  readonly key: string;
  title: string;
  mode: string;
  description: string;
  /** First entry is the owner (may be ""). */
  oplist: readonly string[];
  readonly members: Set<string>;
}

export class SessionState {
  vars: ServerVars = DEFAULT_SERVER_VARS;
  ownCharacter: string | undefined;
  connectedCount = 0;
  readonly characters = new Map<string, CharacterPresence>();
  readonly channels = new Map<string, ChannelState>();
  /** Ignore list, lowercased key → canonical casing (server-authoritative:
   * seeded by IGN init at login, adjusted by add/delete acks). */
  readonly ignores = new Map<string, string>();
  /** True once this connection's IGN init arrived — before that, an empty
   * `ignores` means "not seeded yet", not "nobody ignored". */
  ignoresSeeded = false;
  /** Chatops (global moderators), from ADL at login. */
  readonly chatops = new Set<string>();

  /** Whether our own character is a chatop (gates the admin UI). */
  get ownIsChatop(): boolean {
    return (
      this.ownCharacter !== undefined && this.chatops.has(this.ownCharacter)
    );
  }

  /** F-Chat resolves names case-insensitively. */
  isIgnored(character: string): boolean {
    return this.ignores.has(character.toLowerCase());
  }

  /** Folds one inbound command into the roster. Ignores non-state commands. */
  apply(command: ServerCommand): void {
    switch (command.cmd) {
      case "IDN":
        this.ownCharacter = command.payload.character;
        return;
      case "IGN": {
        const { action, character, characters } = command.payload;
        if (action === "init") {
          this.ignores.clear();
          this.ignoresSeeded = true;
          for (const name of characters ?? []) {
            this.ignores.set(name.toLowerCase(), name);
          }
        } else if (action === "add" && character !== undefined) {
          this.ignores.set(character.toLowerCase(), character);
        } else if (action === "delete" && character !== undefined) {
          this.ignores.delete(character.toLowerCase());
        }
        return;
      }
      case "VAR":
        this.vars = applyVar(this.vars, command.payload);
        return;
      case "CON":
        this.connectedCount = command.payload.count;
        return;
      case "LIS":
        for (const [name, gender, status, statusmsg] of command.payload
          .characters) {
          this.characters.set(name, { gender, status, statusmsg });
        }
        return;
      case "NLN":
        this.characters.set(command.payload.identity, {
          gender: command.payload.gender,
          status: command.payload.status,
          statusmsg: "",
        });
        return;
      case "FLN": {
        // "FLN is treated as a global LCH for that character."
        this.characters.delete(command.payload.character);
        for (const channel of this.channels.values()) {
          channel.members.delete(command.payload.character);
        }
        return;
      }
      case "STA": {
        const presence = this.characters.get(command.payload.character);
        if (presence) {
          presence.status = command.payload.status;
          presence.statusmsg = command.payload.statusmsg;
        }
        return;
      }
      case "JCH": {
        const { channel: key, character, title } = command.payload;
        let channel = this.channels.get(key);
        if (!channel) {
          // First JCH for a channel is our own join echo.
          channel = {
            key,
            title,
            mode: "both",
            description: "",
            oplist: [],
            members: new Set(),
          };
          this.channels.set(key, channel);
        }
        channel.title = title;
        channel.members.add(character.identity);
        return;
      }
      case "ICH": {
        const channel = this.channels.get(command.payload.channel);
        if (channel) {
          channel.mode = command.payload.mode;
          channel.members.clear();
          for (const user of command.payload.users) {
            channel.members.add(user.identity);
          }
        }
        return;
      }
      case "COL": {
        const channel = this.channels.get(command.payload.channel);
        if (channel) {
          channel.oplist = [...command.payload.oplist];
        }
        return;
      }
      case "CDS": {
        const channel = this.channels.get(command.payload.channel);
        if (channel) {
          channel.description = command.payload.description;
        }
        return;
      }
      case "RMO": {
        const channel = this.channels.get(command.payload.channel);
        if (channel) {
          channel.mode = command.payload.mode;
        }
        return;
      }
      case "ADL": {
        this.chatops.clear();
        for (const op of command.payload.ops) {
          this.chatops.add(op);
        }
        return;
      }
      case "COA": {
        const channel = this.channels.get(command.payload.channel);
        if (channel && !channel.oplist.includes(command.payload.character)) {
          channel.oplist = [...channel.oplist, command.payload.character];
        }
        return;
      }
      case "COR": {
        const channel = this.channels.get(command.payload.channel);
        if (channel) {
          // The owner slot only moves via CSO — never strip index 0.
          channel.oplist = channel.oplist.filter(
            (op, index) => index === 0 || op !== command.payload.character,
          );
        }
        return;
      }
      case "CSO": {
        const channel = this.channels.get(command.payload.channel);
        if (channel) {
          channel.oplist = [
            command.payload.character,
            ...channel.oplist
              .slice(1)
              .filter((op) => op !== command.payload.character),
          ];
        }
        return;
      }
      // Kick / ban / timeout remove the character like a leave — the frame
      // IS the leave signal, the server sends no separate LCH.
      case "CKU":
      case "CBU":
      case "CTU": {
        const { channel: key, character } = command.payload;
        if (character === this.ownCharacter) {
          this.channels.delete(key);
          return;
        }
        this.channels.get(key)?.members.delete(character);
        return;
      }
      case "LCH": {
        const { channel: key, character } = command.payload;
        if (character === this.ownCharacter) {
          this.channels.delete(key);
          return;
        }
        this.channels.get(key)?.members.delete(character);
        return;
      }
      default:
        return;
    }
  }

  /** Called when the connection drops: per-connection state is void. The
   * ignore list is included — IGN init re-seeds it on every identify. */
  resetVolatile(): void {
    this.ownCharacter = undefined;
    this.connectedCount = 0;
    this.characters.clear();
    this.channels.clear();
    this.ignores.clear();
    this.ignoresSeeded = false;
    this.chatops.clear();
  }
}
