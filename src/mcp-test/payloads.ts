/**
 * MCP-E3 — the strings the adversarial styles put into tool arguments. They are generic, written for this project, and
 * known to be harmless: they test that a server refuses or sanitises, never that an attack works. Characters that cannot
 * be seen are written as escapes, so this file holds none of them raw. Nothing here is shaped like a real credential, and
 * no path points at a real file.
 */
export const SQL_INJECTION = "' OR '1'='1";
export const SCRIPT_INJECTION = "<script>alert(1)</script>";
/** A command substitution that names a command that does not exist: if it were run, nothing useful would happen. */
export const COMMAND_SUBSTITUTION = "$(cairn-sentinel-no-such-command)";
/** A path that goes up one level to a name that does not exist. */
export const PATH_TRAVERSAL = "../cairn-sentinel-not-a-real-file";
/** A byte of zero in the middle of a string. */
export const NULL_BYTE_STRING = "a\u0000b";
/** A high surrogate with no low surrogate after it: not valid Unicode text. */
export const LONE_SURROGATE_STRING = "a\uD800b";
export const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;
export const SENTINEL_EXTRA_PROPERTY = "cairn_extra_property";
export const SENTINEL_PROTO_VALUE = "cairn-sentinel";
