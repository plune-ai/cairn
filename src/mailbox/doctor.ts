import { MailsacProvider } from "./mailsac.js";

/**
 * `cairn doctor` (ADR-0023): whether MAILSAC_API_KEY is set, which domain the addresses use (and whether it is the public
 * one), and one read on that domain with the key: the service's reply. Never prints the key, an address or a message.
 * Never throws: a missing key or a rejected one is a finding.
 */
export async function mailboxDoctorReport(
  env: Record<string, string | undefined>,
  opts: { fetch?: typeof fetch; baseUrl?: string } = {},
): Promise<string[]> {
  const head = ["", "Test mailbox (Mailsac — ADR-0023)"];
  const apiKey = env.MAILSAC_API_KEY;
  if (!apiKey) return [...head, "  – MAILSAC_API_KEY is not set: steps that read e-mail are unavailable (TOTP needs no key)"];
  const address = env.MAILSAC_ADDRESS || undefined;
  const domain = address?.split("@")[1] ?? (env.MAILSAC_DOMAIN || "mailsac.com");
  const lines = [
    ...head,
    "  ✓ MAILSAC_API_KEY is set",
    // ponytail: only Mailsac's own default domain is flagged; add others if a run uses them
    domain === "mailsac.com"
      ? "  ⚠ Domain: mailsac.com is public — anyone who knows an address can read it; set MAILSAC_DOMAIN to a private domain for personal data"
      : `  Domain: ${domain}`,
  ];
  const provider = new MailsacProvider({ apiKey, address, domain: env.MAILSAC_DOMAIN || undefined, attempts: 1, ...opts });
  const t0 = Date.now();
  try {
    await provider.list(await provider.createAddress("doctor"));
    lines.push(`  ✓ Mailsac answered for ${domain}: key accepted (${Date.now() - t0} ms)`);
  } catch (e) {
    lines.push(`  ✗ ${(e as Error).message}`);
  }
  return lines;
}
