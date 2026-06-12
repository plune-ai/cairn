/**
 * CLI branding + the deprecated-alias notice (C0-03 / C0-04).
 *
 * `cairn` is the primary command; `lex-bot` remains a hidden, deprecated alias
 * (see src/cli/lex-bot.ts) that prints {@link LEXBOT_CLI_NOTICE} before delegating
 * to the same code path. Nothing is removed yet — full backward compatibility.
 */
export const PRIMARY_BIN = "cairn" as const;
export const DEPRECATED_BIN = "lex-bot" as const;

/** Product tagline (umbrella framing across surfaces). */
export const TAGLINE =
  "Cairn — an AI that walks your system and leaves a trail of tests: UI, API, unit, docs." as const;

/** One-line notice printed to stderr when invoked via the legacy `lex-bot` alias. */
export const LEXBOT_CLI_NOTICE =
  "⚠ `lex-bot` is deprecated and will be removed in 1–2 releases — use `cairn` instead." as const;
