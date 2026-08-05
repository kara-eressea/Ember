// The F-Chat session engine: one held connection per character identity, its
// state projection, its outbound rate gate, the typed event bus everything
// downstream subscribes to, and the F-List API/ticket/credential machinery a
// session needs to authenticate. Host-agnostic by construction — every I/O
// concern beyond the WebSocket itself is injected (`SessionLogger`) or
// inverted through the event bus, so the same engine drives the Fastify
// bouncer and the embedded desktop bouncer (design/standalone-client.md).
export * from "./api-client.js";
export * from "./event-bus.js";
export * from "./fchat-session.js";
export * from "./rate-gate.js";
export * from "./registry.js";
export * from "./session-state.js";
export * from "./ticket-manager.js";
export * from "./vault.js";
