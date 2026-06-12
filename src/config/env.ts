/**
 * Env-var resolution with the CAIRN_ prefix and backward-compatible fallbacks (C0-06).
 *
 * For each logical name, resolution order is:
 *   CAIRN_<name>  →  LEXBOT_<name>  →  LEX_<name>  →  <name>  (bare/current)
 *
 * The new `CAIRN_` prefix and the current bare names are first-class; the legacy
 * `LEXBOT_`/`LEX_` forms keep working but emit a one-time deprecation warning so
 * users can migrate. Nothing is removed — this is purely additive back-compat.
 */

export type EnvRecord = Record<string, string | undefined>;

/** Legacy product prefixes, in precedence order (newer legacy form first). */
const LEGACY_PREFIXES = ["LEXBOT_", "LEX_"] as const;

const defaultWarn = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};

/**
 * Build an env reader bound to a raw env record. Returns `read(name)` which applies
 * the CAIRN_ → legacy → bare resolution above. Legacy hits warn once per variable
 * (deduped for the lifetime of this reader, i.e. once per process in the CLI).
 */
export function createEnvReader(
  raw: EnvRecord,
  warn: (msg: string) => void = defaultWarn,
): (name: string) => string | undefined {
  const warned = new Set<string>();
  return (name: string): string | undefined => {
    const preferred = raw[`CAIRN_${name}`];
    if (preferred !== undefined) return preferred;

    for (const prefix of LEGACY_PREFIXES) {
      const key = `${prefix}${name}`;
      const value = raw[key];
      if (value !== undefined) {
        if (!warned.has(key)) {
          warned.add(key);
          warn(
            `[cairn] env ${key} is deprecated — use CAIRN_${name} instead ` +
              `(old name still works; removal planned in 1–2 releases).`,
          );
        }
        return value;
      }
    }

    return raw[name];
  };
}
