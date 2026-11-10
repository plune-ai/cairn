// Loaded with `node --import` by tests/integration/mcp-stdio.test.ts: makes the optional MCP server package look
// uninstalled, the way `npm i --omit=optional` leaves it, without touching node_modules. Every import of
// `@modelcontextprotocol/server` (and its subpaths) resolves to a package name that does not exist, so Node raises
// its own ERR_MODULE_NOT_FOUND.
import { register } from "node:module";

const hooks = `
export async function resolve(specifier, context, next) {
  if (specifier === "@modelcontextprotocol/server" || specifier.startsWith("@modelcontextprotocol/server/")) {
    return next(specifier.replace("@modelcontextprotocol/server", "@modelcontextprotocol/server-not-installed"), context);
  }
  return next(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);
