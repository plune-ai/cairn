import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "site");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
};

export interface FixtureServer {
  url: string;
  /** Every POST the site sent, with its headers — what a page really sent, beside what Cairn recorded of it. */
  posts: { url: string; headers: Record<string, string | string[] | undefined> }[];
  /** #225 review 3: every request that could change the server (any method but GET, HEAD, OPTIONS), in order. */
  writes: { method: string; url: string }[];
  close: () => Promise<void>;
}

/**
 * Starts a static HTTP server for the fixture site on a random port (real localhost origin). A write (POST, PUT,
 * PATCH, DELETE…) answers 204;
 * `?delay=<ms>` holds any answer that long; `/api/ok` answers "ok" (to any origin), `/api/long` never answers.
 * With `basicAuth` ("user:password"), everything answers 401 to a request without it.
 */
export async function startFixtureServer(opts: { basicAuth?: string } = {}): Promise<FixtureServer> {
  const posts: FixtureServer["posts"] = [];
  const writes: FixtureServer["writes"] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      if (opts.basicAuth && req.headers.authorization !== `Basic ${Buffer.from(opts.basicAuth).toString("base64")}`) {
        res.statusCode = 401;
        res.setHeader("www-authenticate", 'Basic realm="fixture"');
        res.end();
        return;
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        writes.push({ method, url: req.url ?? "" });
        if (method === "POST") posts.push({ url: req.url ?? "", headers: req.headers });
        res.statusCode = 204;
        res.end();
        return;
      }
      const query = new URL(req.url ?? "/", "http://fixture").searchParams;
      await new Promise((r) => setTimeout(r, Number(query.get("delay") ?? 0)));
      res.setHeader("access-control-allow-origin", "*");
      try {
        const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
        if (urlPath === "/api/ok") {
          res.end("ok");
          return;
        }
        if (urlPath === "/api/long") return; // a long poll: the answer never comes while the test runs
        const rel = urlPath === "/" ? "/login.html" : urlPath;
        const filePath = normalize(join(root, rel));
        if (!filePath.startsWith(root)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        const data = await readFile(filePath);
        const ext = filePath.slice(filePath.lastIndexOf("."));
        res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
        res.end(data);
      } catch {
        res.statusCode = 404;
        res.end("not found");
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    posts,
    writes,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections(); // a long poll still holds one open
      }),
  };
}
