/**
 * An `importer` for `connectMcp` whose stdio transport hides the SDK's private process field, like an SDK version that
 * renamed it: everything is delegated to the real transport, which keeps working, but the size counter cannot be installed.
 */
export async function noProcessImporter(specifier: string): Promise<unknown> {
  const mod = (await import(specifier)) as Record<string, unknown>;
  if (specifier !== "@modelcontextprotocol/sdk/client/stdio.js") return mod;
  const Real = mod["StdioClientTransport"] as new (p: unknown) => Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  class Stub {
    private inner: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    constructor(p: unknown) {
      this.inner = new Real(p);
    }
    start(): Promise<void> {
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
