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
  close: () => Promise<void>;
}

/** Starts a static HTTP server for the fixture site on a random port (real localhost origin). */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
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
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
