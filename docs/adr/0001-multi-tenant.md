# ADR 0001 — Multi-tenant mode is deferred

**Status:** Accepted (deferred)
**Date:** 2026-10-25

## Context
The code contains SaaS foundations (`shops` table, `shop_id` on every tenant
table, RLS policies, public `register-shop`). In practice the app is used as a
single shop (`bn-smart`):

- The login UI has no shop-slug field, so only `bn-smart` is reachable.
- RLS is enabled but **not enforced** when the database connects as the table
  owner (Render's default role). A second shop created through the API can read
  all shops' data.
- Because receipt numbers are per shop but the tracking code is globally unique,
  enabling isolation would make two shops collide on `QF-####`.

## Decision
Do not enable or rely on multi-tenant isolation now. Keep the `shop_id`
columns for a future migration, but treat the product as **single-shop**.

## Consequences
- The public `register-shop` endpoint remains a known risk until it is closed.
- Security work must not assume RLS. Authorization is enforced in the API
  (`auth` + `manager` + `can`) and finance is manager-only.
- If multi-tenant is ever enabled: add `FORCE ROW LEVEL SECURITY`, a non-owner
  database role, per-shop receipt numbering, and a slug field in login; then
  close public registration.
