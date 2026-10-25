# API — BN SMART

All paths are under `/api`. Authenticated requests send
`Authorization: Bearer <token>`.

## Auth
| Method | Path | Access | Notes |
|---|---|---|---|
| POST | `/api/auth/register-shop` | public | Creates a shop + manager |
| POST | `/api/auth/login` | public | Body: `username`, `password`, optional `shopSlug` |
| GET | `/api/auth/me` | authenticated | Current DB-backed user |
| POST | `/api/auth/change-password` | authenticated | Own password |

## Repairs
| Method | Path | Access |
|---|---|---|
| GET | `/api/repairs?search=&status=` | `view_repairs` |
| GET | `/api/repairs/:id` | `view_repairs` |
| POST | `/api/repairs` | `add_repair` |
| PATCH | `/api/repairs/:id` | `edit_repair` |
| DELETE | `/api/repairs/:id` | `delete_repairs` |
| PATCH | `/api/repairs/:id/status` | `change_status` |
| PATCH | `/api/repairs/:id/received` | `edit_repair` |
| POST | `/api/repairs/:id/payments` | `edit_repair` — capped at remaining |
| GET/POST | `/api/repairs/:id/parts` | `view_repairs` / `edit_repair` |
| DELETE | `/api/repairs/:id/parts/:partId` | `edit_repair` |

## Customers / users / suppliers
| Method | Path | Access |
|---|---|---|
| GET/POST | `/api/customers` | `customers` |
| GET/POST/PATCH/DELETE | `/api/users...` | manager |
| GET | `/api/suppliers` | `inventory` (money hidden from workers) |
| GET | `/api/suppliers/:supplier/purchases` | `inventory` |
| POST | `/api/suppliers/purchases` | `inventory` — `paid ≤ total` |
| DELETE | `/api/suppliers/purchases/:id` | manager |

## Dashboard / reports / admin
| Method | Path | Access |
|---|---|---|
| GET | `/api/dashboard` | `view_repairs` (finance removed for workers) |
| GET | `/api/reports/daily?period=7\|30\|90\|all` | `reports` |
| GET | `/api/history/by-date?date=YYYY-MM-DD` | manager |
| GET | `/api/activity` | manager |
| GET | `/api/settings` | `settings` |
| PUT | `/api/settings` | manager |
| GET | `/api/backup` | manager |

## Public
| Method | Path | Access |
|---|---|---|
| GET | `/api/track/:code` | public |
| GET | `/api/qr/:code` | public (PNG) |
| GET | `/track/:code`, `/share/:code` | public pages |
| GET | `/health` | public |

Unknown `/api/*` paths return `404 {"error":"...​"}`.
