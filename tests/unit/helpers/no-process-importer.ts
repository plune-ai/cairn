/**
 * An `importer` for `connectMcp` whose stdio transport hides the SDK's private process field, like an SDK version that
 * renamed it: everything is delegated to the real transport, which keeps working, but the size counter cannot be installed.
 */
export const noProcessImporter = (specifier: string): Promise<unknown> => build(specifier, {}, { made: 0 });

/** The same, and every transport started after the first `failAfter` ones fails to start (a server that cannot be started again). */
export const failingImporter = (failAfter: number): ((specifier: string) => Promise<unknown>) => {
  const shared = { made: 0 };
  return (specifier) => build(specifier, { failAfter }, shared);
};

async function build(specifier: string, opts: { failAfter?: number }, shared: { made: number }): Promise<unknown> {
  const mod = (await import(specifier)) as Record<string, unknown>;
  if (specifier !== "@modelcontextprotocol/sdk/client/stdio.js") return mod;
  const Real = mod["StdioClientTransport"] as new (p: unknown) => Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  class Stub {
    private inner: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    private n: number;
    constructor(p: unknown) {
      this.inner = new Real(p);
      this.n = ++shared.made;
    }
    start(): Promise<void> {
      // A server that cannot be started again: every start after the first `failAfter` ones fails.
      if (opts.failAfter !== undefined && this.n > opts.failAfter) return Promise.reject(Object.assign(new Error("spawn refused"), { code: "EACCES" }));
      return this.inner["start"]();
    }
    close(): Promise<void> {
      return this.inner["close"]();
    }
    send(m: unknown): Promise<void> {
      return this.inner["send"](m);
    }
    get stderr(): unknown {
      return this.inner["stderr"];
    }
    get pid(): number | null {
      return this.inner["pid"];
    }
    get onclose(): unknown {
      return this.inner["onclose"];
    }
    set onclose(f: unknown) {
      this.inner["onclose"] = f;
    }
    get onerror(): unknown {
      return this.inner["onerror"];
    }
    set onerror(f: unknown) {
      this.inner["onerror"] = f;
    }
    get onmessage(): unknown {
      return this.inner["onmessage"];
    }
    set onmessage(f: unknown) {
      this.inner["onmessage"] = f;
    }
  }
  return { ...mod, StdioClientTransport: Stub };
}
