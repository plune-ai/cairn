import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface EnvAppOptions {
  /** Every request needs this Basic Auth pair (else 401). */
  basic?: { user: string; pass: string };
  /** /login accepts this pair; /start and /home need the session cookie it sets. */
  login?: { user: string; pass: string };
}

export interface EnvApp {
  url: string;
  /** Requests in arrival order, e.g. "GET /login", "POST /login", "GET /start" (only authorized ones are marked). */
  log: string[];
  close: () => Promise<void>;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const LOGIN_FORM = (error = ""): string =>
  page(
    "Sign in",
    `<h1>Sign in</h1>${error}<form method="post" action="/login">
<label>Email <input name="email" type="text"></label>
<label>Password <input name="password" type="password"></label>
<button type="submit">Sign In</button></form>`,
  );

/** A local app with optional Basic Auth, a login form (cookie session) and a start path — records the request order. */
export async function startEnvApp(opts: EnvAppOptions = {}): Promise<EnvApp> {
  const log: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const send = (code: number, body: string, headers: Record<string, string> = {}): void => {
      res.writeHead(code, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    if (opts.basic) {
      const want = `Basic ${Buffer.from(`${opts.basic.user}:${opts.basic.pass}`).toString("base64")}`;
      if (req.headers.authorization !== want) {
        log.push(`${req.method} ${path} (401)`);
        send(401, "unauthorized", { "www-authenticate": 'Basic realm="staging"' });
        return;
      }
    }
    log.push(`${req.method} ${path}`);
    const authed = (req.headers.cookie ?? "").includes("sid=ok");
    if (path === "/login" && req.method === "POST") {
      let data = "";
      req.on("data", (c: Buffer) => (data += c.toString()));
      req.on("end", () => {
        const f = new URLSearchParams(data);
        if (opts.login && f.get("email") === opts.login.user && f.get("password") === opts.login.pass) {
          send(302, "", { location: "/home", "set-cookie": "sid=ok; Path=/" });
        } else send(200, LOGIN_FORM("<p>Wrong email or password</p>"));
      });
      return;
    }
    if (path === "/login") return send(200, LOGIN_FORM());
    if (path === "/" || path === "/home") return send(200, page("Home", "<h1>Home</h1>"));
    if (path === "/start") {
      if (opts.login && !authed) return send(302, "", { location: "/login" });
      return send(200, page("Start", "<h1>Start page</h1><button>Create item</button>"));
    }
    send(404, page("Not found", "<h1>Not found</h1>"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
