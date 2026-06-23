import { describe, it, expect } from "vitest";
import { checkProvenance, guardDeletion, isDeletionIntent } from "../../src/safety/guardrails.js";
import type { PilotVerdict } from "../../src/eval/pilot.js";

const pass = (entity: string, reason = "looks good"): PilotVerdict => ({
  verdict: "pass",
  reason,
  guidance: "ship it",
  entity,
});

describe("checkProvenance (#91 — provenance-checked Pilot verdict)", () => {
  it("keeps a pass when the named entity appears in the session log", () => {
    const v = checkProvenance(pass("Invoice #42"), ["created Invoice #42", "filled amount"]);
    expect(v.verdict).toBe("pass");
  });

  it("REJECTS a pass when the entity is absent from the log → needs-work with a reason", () => {
    const v = checkProvenance(pass("Ghost Item"), ["clicked Save", "navigated to /items"]);
    expect(v.verdict).toBe("needs-work");
    expect(v.reason).toMatch(/provenance/i);
    expect(v.reason).toContain("Ghost Item");
  });

  it("passes a read-only run through (no entity claimed)", () => {
    const v = checkProvenance(pass(""), []); // nothing created → nothing to prove
    expect(v.verdict).toBe("pass");
  });

  it("never upgrades — a non-pass verdict is returned untouched", () => {
    const nw: PilotVerdict = { verdict: "needs-work", reason: "gaps", guidance: "more cases", entity: "X" };
    expect(checkProvenance(nw, [])).toEqual(nw);
  });

  it("matches the entity case-insensitively", () => {
    expect(checkProvenance(pass("WIDGET"), ["created a widget"]).verdict).toBe("pass");
  });
});

describe("guardDeletion (#91 — data-protection guardrail)", () => {
  it("ALLOWS deleting a self-created item (disposable)", () => {
    const r = guardDeletion("temp-item-1", { selfCreated: ["temp-item-1"] });
    expect(r.allowed).toBe(true);
  });

  it("BLOCKS deleting pre-existing data, with a clear reason", () => {
    const r = guardDeletion("Customer Acme", { selfCreated: ["temp-item-1"] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/pre-existing/i);
    expect(r.reason).toContain("Customer Acme");
  });

  it("BLOCKS deleting the resource under the current URL", () => {
    const r = guardDeletion("https://app/items/1", { currentUrl: "https://app/items/1/", selfCreated: ["https://app/items/1"] });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/current URL/i);
  });

  it("BLOCKS an empty target", () => {
    expect(guardDeletion("   ").allowed).toBe(false);
  });

  it("matches self-created entries case/trailing-slash insensitively", () => {
    expect(guardDeletion("Temp-Item-1", { selfCreated: ["temp-item-1 "] }).allowed).toBe(true);
  });
});

describe("isDeletionIntent (#91 — gate for stateful setup steps)", () => {
  it("flags delete/clear/reset intents", () => {
    for (const t of ["delete all existing items", "clear the list", "reset the account", "purge old records", "clean up data"]) {
      expect(isDeletionIntent(t), t).toBe(true);
    }
  });

  it("does not flag read/create intents", () => {
    for (const t of ["log in as admin", "an existing item is in the list", "create a new invoice"]) {
      expect(isDeletionIntent(t), t).toBe(false);
    }
  });
});
