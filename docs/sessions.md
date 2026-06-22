# Authenticated targets

Cairn explores your app **as a logged-in user**. You capture the login **once** into a Playwright
`storageState` (cookies + localStorage); every later run reuses it — no credentials in code, no
re-login per run.

```bash
# 1. Capture once — a real browser opens; log in by hand, then press Enter.
cairn session capture --url https://your-app.example.com/login --name myapp

# 2. Point Cairn at any page behind that login, reusing the session.
cairn explore --url https://your-app.example.com/dashboard --session myapp
```

- **Pointing Cairn at your OWN gated app?** That's the intended flow — capture against your login page, then `explore` / `design` any authenticated page with `--session <name>`.
- **OAuth / Google login** (blocks automated browsers): add `--channel chrome` to drive your real Google Chrome. `--channel` works on `session capture`, `observe`, `design`, `explore`, and `automate --validate` — and needs **no bundled-Chromium download**, so it's also the simplest way to run inside a project that already has its own Playwright. (Without a channel, Cairn uses the bundled Chromium from `cairn install-browsers`.)
- **Manage sessions:** `cairn session ls` lists saved sessions; `cairn session rm <name>` deletes one. (`cairn login` is a shorthand for `cairn session capture`.)
- **Already have a `storageState.json`?** Skip capture and pass it directly: `--session-file ./path/to/state.json`.
- **Expired session?** If the first page Cairn sees looks like a login screen, it stops with a clear *re-capture* message instead of exploring the sign-in page.
- **Secrets hygiene:** sessions live in `.auth/` (matching `*.storageState.json`), which is **gitignored** — never committed. Treat the files like passwords.

> Working inside the repo? `npm run session:save -- --url <u> --name <s>` still works — it's a thin wrapper over the same capture logic that ships as `cairn session capture`.
