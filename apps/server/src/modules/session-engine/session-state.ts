// In-memory roster for one F-Chat session: server vars, online characters,
// joined channels, own identity. Volatile by design — the gateway serves
// snapshots from here (architecture.md), while durable history goes through
// the event bus to the history sink.

import {
  applyVar,
  DEFAULT_SERVER_VARS,
  type ServerCommand,
  type ServerVars,
} from "@emberline/fchat-protocol";

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

  /** Folds one inbound command into the roster. Ignores non-state commands. */
  apply(command: ServerCommand): void {
    switch (command.cmd) {
      case "IDN":
        this.ownCharacter = command.payload.character;
        return;
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

  /** Called when the connection drops: per-connection state is void. */
  resetVolatile(): void {
    this.ownCharacter = undefined;
    this.connectedCount = 0;
    this.characters.clear();
    this.channels.clear();
  }
}
