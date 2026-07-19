# mosni/files

`files.mosni.dev` — Hannah's File Drop. A file-sharing app whose entire product invariant is the fast
path: **open `files.mosni.dev` → drop file → click to copy link.** Everything else is optional and
defaulted. See `agent-docs/technical-baseline.md` and `agent-docs/current-context.md` for the full
constraints and architecture; this README covers development and deploy mechanics only.

E1 (this epic) builds the empty repo into a deployable, hardened, verifiable service that does nothing
user-facing yet — no upload, preview, or browsing behaviour ships here.

## Two-origin model (D-4)

Uploaded content is attacker-controlled, so file bytes are served **only** from `dl.mosni.dev`, never from
`files.mosni.dev`. Node never streams bytes (security invariant 2) — nginx serves them via
`X-Accel-Redirect` from an `internal;` location once the app has authorized the request. **No cookie is
ever set on `dl.mosni.dev` and the auth SDK is never loaded there** — either would undo the containment
this split buys. One certificate covers both names (see `nginx.conf`).

## Development

- Install: `npm ci` (reproducible install from the committed lockfile; use `npm install` only when
  intentionally changing a dependency, then commit the resulting lockfile diff).
- `npm run dev` — Vite dev server for the SPA.
- `npm run test:unit` — the fast, service-free inner loop for TDD: `app/test/unit` only, no
  MariaDB/redis, no coverage gate, no builds. Seconds once the Docker build cache is warm. Not a
  substitute for `npm run verify` — see below.
- `npm run verify` — **the single verification command** and part of the definition of done for every
  change. Runs `tsc --noEmit` on the host, then `vitest run --coverage` (unit + integration, hard-gated at
  90% line coverage) and both Vite builds inside Docker against real MariaDB + redis service containers
  (`docker-compose.verify.yml`). Runs in Docker rather than on the host because the dev checkout is on
  Node 20 against a Node 24 target — a host-native gate would pass or fail differently per machine.
  A test belongs in `app/test/unit/` only if it needs no live MariaDB/redis connection — if it reaches for
  a real service, it belongs in `app/test/integration/` instead, or `test:unit` stops being service-free.

This repo is **TDD**: write the failing test first, then the implementation. Coverage below 90% fails
`npm run verify`, so the task is not done. Mandatory, never-delete tests (each maps to a security
invariant) are listed in `agent-docs/verification-concept.md` and must never be deleted, skipped, or
weakened to make a change pass.

## Browser-driven e2e (D-53, reverses D-28)

`e2e/` holds Playwright specs, run only via `npx playwright test` / `npm run test:e2e` — **never** through
Vitest (`vitest.config.ts` explicitly excludes `e2e/`; Playwright's own `test()` global conflicts with
Vitest's). `npm run test:e2e` builds the real production image (`Dockerfile`, not just the Vite outputs)
as `app-e2e`, runs it against real MariaDB + redis, and drives a real Chromium against it as `verify-e2e`
(`docker-compose.verify.yml`). E1 ships no real UI, so `e2e/smoke.spec.ts` only proves the pipeline itself
works; real coverage of browser-only behaviour (drag/drop, clipboard, upload resume, mobile pickers) lands
with the epics that ship it — until then those stay on the manual-check list in
`agent-docs/verification-concept.md`.

### Debug entrypoint: screenshotting the running app

`scripts/screenshot.mjs` is a standalone Playwright script (not a test) for review sessions and humans to
grab a screenshot of the running app — optionally after performing an action — without driving a browser
by hand. It only drives the browser; **the app must already be running and reachable** at `BASE_URL`
(default `http://localhost:3000`) before you run it.

```sh
# One-time: install a browser for the script to drive
npx playwright install chromium

# Start the app somewhere reachable (pick one):
docker compose up -d app                    # the real production image
# or: npm run dev                           # Vite dev server, SPA only

# Bare screenshot
BASE_URL=http://localhost:33001 npm run screenshot -- / drop.png

# After an action - click, fill, wait for a result, or run arbitrary JS, in order, before capturing:
npm run screenshot -- / after-copy.png --click "#copy-link" --wait ".toast"
npm run screenshot -- / after-fill.png --fill "#rename-input" "photo(2).png" --click "#save"
```

Supported action flags: `--click <selector>`, `--fill <selector> <value>`, `--wait <selector>` (waits for
an element to appear - useful after an async action), `--eval <jsExpression>` (runs arbitrary JS in the
page via `page.evaluate`). Multiple actions run in the order given.

**Verified working during E1** (session 004) against the running `app-e2e` container: a bare screenshot of
the placeholder shell, and a screenshot after an `--eval` action that rewrote the page content -
confirming the action actually executes before the capture, not just that the file gets written.

## Layout

```text
app/
  src/
    server.ts    # Fastify bootstrap only - no business logic
    config.ts     # env loading + validation (fails fast and loudly on a missing var)
    routes/       # thin controllers (empty in E1)
    views/        # server-rendered .tsx pages (empty in E1)
    lib/          # pure, I/O-free logic: roles.ts (can()), mime.ts, audit.ts (line formatting)
    storage/      # the ONLY layer that touches MariaDB/redis/the filesystem: db.ts, redis.ts,
                  # schema.sql, audit.ts (the actual emit)
    auth/         # verify.ts (vendored JWT verification), grantable-roles.ts (boot-time registration)
  test/
    unit/         # lib + config + auth unit tests
    integration/   # against real MariaDB/redis (schema self-healing, security headers)
web/
  src/
    components/   # the React 19 SPA (drop zone, browser, admin panel) - empty in E1
```

## Deploy

Standard stack ritual (`../infrastructure/docs/operations.md`): an entry in `apps.list`, this
self-contained repo (`docker-compose.yml` + `nginx.conf` + `.env.example`), and GitHub OIDC deploy with no
stored secrets (`.github/workflows/deploy.yml`).

**Box-time steps, every fresh deploy of a new box (or first deploy of this app):**

1. Confirm the next free port in the stack range (`../infrastructure/stack.env`,
   `PORT_BASE`..`PORT_MAX`; scan `apps/*/docker-compose.yml` for `127.0.0.1:<port>`). `33001` is a
   placeholder here — auth already occupies `33000`. Replace it in **both** `docker-compose.yml`'s
   `ports:` mapping and `nginx.conf`'s `proxy_pass`.
2. Copy `.env.example` to `.env` and fill in every var — `config.ts` fails fast and loudly at boot if one
   is missing.
3. The TLS certificate for `files.mosni.dev` + `dl.mosni.dev` is issued automatically on first deploy by
   `../infrastructure/lib/deploy` (`ensure_cert()`, D-47) before the vhost is linked — no manual step
   needed. If it ever needs reissuing by hand: `certbot certonly --standalone -d files.mosni.dev -d
   dl.mosni.dev` (stop nginx first; standalone needs port 80/443 free).
4. `docker inspect` the running container and confirm the `files` network alias is present — without it
   every internal auth call returns `403 unknown_caller`.

**Manual checks after any deploy touching this area** (not covered by any automated test —
`agent-docs/verification-concept.md`): `nginx -t` passes; both hosts resolve and serve over TLS;
`curl -I https://files.mosni.dev/health` returns 200 with `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`; a direct request to `dl.mosni.dev`'s internal storage location is refused.
