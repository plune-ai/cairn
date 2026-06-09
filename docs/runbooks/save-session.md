# Runbook: saving a session (storageState: cookies + localStorage)

> **Status:** stub (S1 — accepting a ready storageState; S6 — interactive login)

## What is saved

Playwright `storageState`: **cookies + localStorage + IndexedDB** (NOT sessionStorage).

## Option A — a ready storageState (MVP, S1)

The operator logs in manually and exports the state, then passes it to the bot:

```ts
// a one-off login script
import { chromium } from 'playwright';
const ctx = await (await chromium.launch({ headless: false })).newContext();
const page = await ctx.newPage();
await page.goto('https://app.example.com/login');
// ... log in manually ...
await ctx.storageState({ path: './.auth/demo.storageState.json' });
```

Then: `lex-bot explore --url ... --session demo` (the bot reads `./.auth/demo.storageState.json`).

## Option B — interactive login by the bot (S6)

`lex-bot session login --url ... --session demo` opens a browser, waits for a manual login, and saves the state.

## Security (MANDATORY)

- `.auth/` and `*.storageState.json` are in `.gitignore`. **Never commit.**
- Sessions expire → the bot must detect expired auth (S6, `isValid`).
