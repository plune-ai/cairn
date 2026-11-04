# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue.

Use GitHub's private vulnerability reporting on this repository: open the
[**Security**](https://github.com/plune-ai/cairn/security/advisories/new) tab and choose
**Report a vulnerability**. We aim to acknowledge new reports within a few business days.

Please include the version you used, the steps to reproduce, and the impact you expect.

## Scope

Cairn drives a browser, and can send API requests, against systems you point it at, following
instructions from a language model. In scope:

- The `@plune-ai/cairn` npm package and the `cairn` binary
- Cairn leaking a saved session (`.auth/<name>.storageState.json`, created by `cairn session capture`)
  or a configured secret into run output, logs or traces
- Cairn acting outside the target you named (for example crawling or sending requests to another
  origin or host)
- Injection through page content that makes Cairn run commands on your machine

## Out of scope

- Vulnerabilities in the target application that Cairn found — please report those to that
  application's owner
- The language-model provider's own service
- Vulnerabilities in third-party dependencies — please report those to the upstream project
- Issues that require local access to a machine already running Cairn

## Handling run artifacts

Saved sessions and run output can contain credentials and data from the target. `.auth/` and
`runs/` are listed in `.gitignore`; keep them out of version control and out of shared CI
artifacts. API runs write evidence, including response bodies, to `api-evidence.json`; only the
secret values Cairn knows about and sensitive header names are masked there.
