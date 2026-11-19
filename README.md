# CK SYS V3

CK SYS V3 is a single-project React and Node.js ERP for CK Plastics and AR Plastics. The Vite frontend and all 112 Node API routes deploy together on Vercel under one domain. Supabase provides Authentication, PostgreSQL, Row Level Security, Storage, and the transactional ERP functions.

Production: [https://ck-sys-v3.vercel.app](https://ck-sys-v3.vercel.app)

## Included features

- CK/AR company portals with database-enforced roles and permissions
- Supabase Auth sign-in, recovery OTP/link flows, and secure password changes
- Super-administrator account creation, activation/deactivation, and controlled removal
- Raw-material purchasing, conversions, piecework, production, and finished stock
- Product catalogue with Supabase Storage images and public customer order requests
- Quotations, invoices, partial receipts, balances, and server-calculated COGS
- Employees, daily targets, overtime, payroll, paysheets, and settlements
- Double-entry journals, warning-confirmed universal journals, ledger, financial reports, PDF Studio, immutable reversals, and audit history
- Company-scoped destructive reset with explicit confirmation controls
- Responsive React interface and Node-based documentation tooling

## Architecture

```text
Vercel project / one public origin
├── React/Vite frontend (dist/)
└── Node.js Vercel Function (/api/v1/*)
    ├── verifies Supabase user JWT claims
    ├── enforces company access and permissions
    ├── validates every mutation
    └── calls user-scoped PostgREST and atomic ERP RPCs

Supabase project
├── Authentication
├── PostgreSQL + Row Level Security
├── Storage
└── erp_execute and reporting functions
```

The browser never receives `SUPABASE_SECRET_KEY` and never writes ERP tables directly. Normal requests use the signed-in user's access token, so Postgres RLS remains authoritative. Writes go through the database `erp_execute` transaction boundary with an idempotency key.

## Prerequisites

- Node.js 22
- npm
- A Supabase project with every migration in `supabase/migrations/` applied
- A Supabase publishable key
- A rotated server-only `sb_secret_...` key for public catalogue/order RPCs and in-app account creation

## Apply the database

This repository uses ordered imperative migrations. Link the intended Supabase project, then run:

```bash
npx supabase db push --remote --yes
```

Run the SQL checks in `supabase/tests/` against a non-production project before cutover. Disable public signup in Supabase Auth. Configure custom SMTP and the checked-in `supabase/templates/recovery.html` template when six-digit recovery PIN delivery is required.

## Local setup

Copy `.env.example` to `.env.local` and set:

```ini
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_API_URL=/api/v1

SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
SUPABASE_SCHEMA=public
APP_ENV=development
```

`SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` may be omitted locally because the Node API falls back to their `VITE_*` equivalents. Never create a `VITE_SUPABASE_SECRET_KEY` variable.

Install and start the full application:

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/v1` to the local Node handler on port 8000. Useful commands:

```bash
npm run dev:api          # Node API only
npm run dev:api:reload   # Node API with file watching
npm run dev:web          # Vite only
npm run check            # lint, all tests, and production build
npm run manual:screenshots
npm run manual:build
```

## Future website product API

Company administrators enable the Live Catalog API at the very bottom of Settings and copy the generated public URL. A static or partner website calls Supabase directly, so it needs no separate backend, database, Supabase key, or private API key:

```js
const response = await fetch('https://PROJECT.supabase.co/functions/v1/website-catalog?catalog_id=CATALOG_ID')
if (!response.ok) throw new Error('Catalog unavailable')
const catalog = await response.json()

console.log(catalog.company)
console.log(catalog.items)
```

The CORS-enabled, versioned response reads the same live Supabase data managed by this admin portal. It contains public company details plus each active product's ID, SKU, name, category, one Storage image URL, selling price, short description, unit, and update time. It never exposes stock, cost, worker, customer, accounting, credential, or write data. Regenerating or disabling the link invalidates the old URL.

See [Website Catalog API](docs/WEBSITE_CATALOG_API.md) for plain HTML and React examples, the response contract, and deployment checks.

The database migration and Supabase-hosted endpoint are deployed once per Supabase project (they are already deployed for the linked CK SYS project):

```bash
npx supabase@2.122.1 db push --linked
npx supabase@2.122.1 functions deploy website-catalog --no-verify-jwt --use-api
```

Partner websites do not run either command. They only use the public URL copied from Settings.

## Deploy everything to one Vercel project

The checked-in `vercel.json` does all routing:

- `/api/v1/*` is routed to the single Node Function in `api/handler.js`.
- React files are built into `dist/`.
- Non-API deep links such as `/ck/dashboard`, `/ar/login`, and `/catalog` receive the SPA entry point.

Create or import one Vercel project from this repository. Add these environment variables for Production and Preview:

| Variable | Exposure | Required |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Browser build | Yes |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser build | Yes |
| `VITE_API_URL` | Browser build | Set to `/api/v1` or omit; this is the default |
| `SUPABASE_URL` | Node Function | Recommended; may match `VITE_SUPABASE_URL` |
| `SUPABASE_PUBLISHABLE_KEY` | Node Function | Recommended; may match the public Vite key |
| `SUPABASE_SECRET_KEY` | Node Function only | Yes for catalogue/order RPCs and account creation |
| `SUPABASE_SCHEMA` | Node Function | Optional; defaults to `public` |
| `APP_ENV` | Node Function | Set to `production` |

Deploy from the repository root:

```bash
npx vercel
npx vercel --prod
```

Do not configure a separate backend project, external API URL, Docker service, or CORS origin. Frontend and backend intentionally share the same Vercel origin.

## Post-deployment verification

Verify these direct URLs in a private browser window:

```text
https://YOUR_DOMAIN/api/v1/health/live
https://YOUR_DOMAIN/api/v1/health/ready
https://YOUR_DOMAIN/login
https://YOUR_DOMAIN/ck/login
https://YOUR_DOMAIN/ar/login
https://YOUR_DOMAIN/catalog
```

Then sign in and test both CK and AR company selection, one read screen, one reversible write, file upload, quotation/invoice PDF generation, payroll, accounting reports, audit export, account administration, and password recovery.

## Security notes

- Rotate any secret key ever shared outside a secret manager.
- Never expose `SUPABASE_SECRET_KEY` through `VITE_*`, source code, logs, screenshots, or browser storage.
- Keep Supabase RLS enabled and treat UI permission checks as usability only.
- Posted operational documents are corrected by reversal, not physical edits.
- Keep the old system read-only until stock, receivables, payables, payroll, and ledger totals reconcile.

More detail is available in [Architecture](docs/ARCHITECTURE.md), [Security](docs/SECURITY.md), [System workflow](docs/SYSTEM_WORKFLOW.md), and [Cutover](docs/CUTOVER.md).
