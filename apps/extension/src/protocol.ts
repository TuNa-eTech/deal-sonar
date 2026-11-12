// Mirror of crates/protocol/src/lib.rs — keep in sync.

export const PROTOCOL_VERSION = 1;

export type Request = { type: "ping"; version: number };

export type Response =
  | { type: "pong"; version: number }
  | { type: "error"; message: string };

/** Native messaging host name; must match the host manifest (see scripts/). */
export const NATIVE_HOST = "com.dealsonar.host";
