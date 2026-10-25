# Architecture — BN SMART

A small **modular monolith**: Express + PostgreSQL + vanilla JS. One shop, a few
staff, tens–hundreds of repairs per day.

## Layout

```
server.js              entry point (kept at root for npm start / Docker)
src/
  config.js            environment loading + validation (fails fast)
  app.js               Express wiring and all HTTP routes
  server.js            boot: init database → listen
  db/pool.js           pg Pool, tenant context, q()/one(), activity log
  db/init.js           schema application, tenant bootstrap, default admin,
                       customer de-duplication and unique index
  middleware/auth.js   auth, manager, can(permission), finance shaping helpers
  lib/constants.js     permissions, statuses, supplier catalog
public/                static frontend (index.html, app pages, PWA assets)
tests/                 node:test API suite (boots the app in-process)
```

Request flow: `routes (app.js) → db (pool) → PostgreSQL`. Route handlers are the
HTTP boundary; they read/validate input, apply permissions, and call the pool.

## Rules

- **Config**: `DATABASE_URL` and `JWT_SECRET` are required at boot. No silent
  fallback to a known secret.
- **Auth**: the JWT carries identity + shop only. Role, active flag and
  permissions are re-read from the database on every request, so deactivation,
  demotion and permission changes take effect immediately.
- **Permissions**: `manager` is the only role that sees shop finance
  (dashboard revenue/profit/remaining, customer totals, supplier totals,
  reports money). `can(permission)` gates every other operation.
- **Customers**: phone is the identity inside a shop. Renaming updates the
  customer in place; a partial unique index `(shop_id, phone) WHERE phone <> ''`
  prevents duplicates, and boot merges any existing duplicates.
- **Money**: payments cannot exceed the remaining amount; supplier payments
  cannot exceed the purchase total.
- **Errors**: every error response is JSON `{ error: "..." }`; unknown `/api`
  paths return `404` instead of the SPA.

## Database

`src/db/init.js` applies `BN-SMART-schema.sql` and then runs idempotent
migrations on boot (tenant columns, RLS, functions, customer de-duplication).
Ordered migration files + `schema_migrations` are the next step (plan Phase 3).

## Testing

```bash
docker compose up -d          # Postgres on localhost:5433 + app on :3000
npm test                      # node:test, boots the app in-process
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, a syntax check, the tests and
`npm audit` against a Postgres service container.

## Deploy

- Production: Render (`render.yaml`), start command `npm start`.
- Local: `docker-compose.yml` (app + Postgres). The Dockerfile is used by
  compose only.
