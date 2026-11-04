import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * #233 — a tiny project API with two users (alice and bob) and a third (carol) who owns the first projects. A user is
 * known by `Authorization: Bearer <user>-token` or by the cookie `sid=<user>`. With `idor: true` a project is read,
 * changed and deleted by anyone signed in (the deliberate IDOR); without it only its owner may, and anyone else gets 404.
 */
export interface IdorAppOptions {
  /** The deliberate IDOR: no owner check on GET / PATCH / DELETE /api/projects/:id. */
  idor: boolean;
  /** Drop the connection (no answer) on this `METHOD user`, e.g. "PATCH bob" — a failure in the middle of a check. */
  dropOn?: string;
  /**
   * Answer this status to `METHOD user` before any access check, and change nothing: `{ "DELETE alice": 302 }` is the
   * owner's session gone (a redirect to /login), `{ "PATCH bob": 422 }` a validation that refuses the body first.
   */
  statusOn?: Record<string, number>;
  /** The create answers 201 without the new project's id (the project is still created). */
  createWithoutId?: boolean;
}

export interface IdorApp {
  url: string;
  /** Projects by id: who owns each and its name. carol's projects 1 and 2 are there from the start. */
  projects: Map<number, { owner: string; name: string }>;
  /** Every request, as `METHOD /path user` (user `-` when nobody is signed in). */
  log: string[];
  close: () => Promise<void>;
}

const USERS = ["alice", "bob", "carol"];

function userOf(req: IncomingMessage): string | undefined {
  const bearer = /^Bearer (\w+)-token$/.exec(req.headers.authorization ?? "")?.[1];
  const cookie = /(?:^|;\s*)sid=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
  const user = bearer ?? cookie;
  return user && USERS.includes(user) ? user : undefined;
}

export async function startIdorApp(opts: IdorAppOptions): Promise<IdorApp> {
  let next = 3;
  const projects = new Map<number, { owner: string; name: string }>([
    [1, { owner: "carol", name: "carol's first" }],
    [2, { owner: "carol", name: "carol's second" }],
  ]);
  const log: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://app").pathname;
      const user = userOf(req);
      log.push(`${req.method} ${path} ${user ?? "-"}`);
      if (opts.dropOn === `${req.method} ${user}`) {
        req.socket.destroy();
        return;
      }
      const json = (status: number, body?: unknown): void => {
        res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
        res.end(body === undefined ? undefined : JSON.stringify(body));
      };
      const forced = opts.statusOn?.[`${req.method} ${user}`];
      if (forced !== undefined) {
        res.writeHead(forced, forced >= 300 && forced < 400 ? { location: "/login" } : { "content-type": "application/json" });
        res.end(forced >= 300 && forced < 400 ? undefined : JSON.stringify({ error: `forced ${forced}` }));
        return;
      }
      if (!user) return json(401, { error: "sign in" });
      if (req.method === "POST" && path === "/api/projects") {
        const { name } = JSON.parse(raw || "{}") as { name?: string };
        const id = next++;
        projects.set(id, { owner: user, name: name ?? "untitled" });
        return json(201, opts.createWithoutId ? { name } : { id, name });
      }
      const m = /^\/api\/projects\/([^/]+)$/.exec(path);
      if (!m) return json(404, { error: "no such route" });
      const id = Number(m[1]);
      const project = projects.get(id);
      // The fixed app answers 404 to anyone but the owner: it does not even say the project exists.
      if (!project || (!opts.idor && project.owner !== user)) return json(404, { error: "not found" });
      if (req.method === "GET") return json(200, { id, ...project });
      if (req.method === "PATCH" || req.method === "PUT") {
        const { name } = JSON.parse(raw || "{}") as { name?: string };
        if (name !== undefined) project.name = name;
        return json(200, { id, ...project });
      }
      if (req.method === "DELETE") {
        projects.delete(id);
        return json(204);
      }
      return json(405, { error: "method not allowed" });
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    projects,
    log,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}
