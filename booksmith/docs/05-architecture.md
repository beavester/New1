# Booksmith — Architecture & Tech Stack

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| **API** | Node.js + Hono | Fast, lightweight, runs everywhere (Node, Bun, Cloudflare Workers). TypeScript-native. |
| **Database** | PostgreSQL 16 | Battle-tested for multi-tenant SaaS. JSONB for flexible fields. Row-level security for tenant isolation. |
| **ORM** | Drizzle ORM | Type-safe, SQL-like, great migration story. Lighter than Prisma. |
| **Auth** | Better Auth | Open-source, self-hostable. Supports email/password, OAuth, SSO. |
| **Queue** | BullMQ + Redis | Job queue for notifications, calendar syncs, webhooks. Reliable, with retries and dead-letter. |
| **Cache** | Redis | Session cache, rate limiting, availability slot caching. |
| **Dashboard UI** | React + Vite | SPA for the admin dashboard. Fast dev experience. |
| **UI Components** | shadcn/ui + Tailwind CSS | Copy-paste components, no vendor lock-in. Accessible by default (Radix primitives). |
| **Booking Page** | Next.js (App Router) | SSR for public booking pages (SEO, fast first paint). Can share React components with dashboard. |
| **Email** | React Email + Resend | Template emails in React. Resend for delivery (or self-host with SMTP). |
| **SMS** | Twilio | Reliable, global coverage. Abstract behind interface for swappability. |
| **Payments** | Stripe SDK | First-class, add PayPal/LemonSqueezy behind a payment provider interface. |
| **File Storage** | S3-compatible (MinIO for self-host) | Customer uploads, invoice PDFs, avatars. |
| **Search** | PostgreSQL full-text | Good enough for customer/booking search at this scale. Upgrade to Meilisearch later if needed. |
| **Deployment** | Docker Compose (self-host) / Fly.io (managed) | Simple, reproducible. Fly.io for managed with global edge. |
| **CI/CD** | GitHub Actions | Standard. Lint, test, build, deploy. |
| **Monitoring** | OpenTelemetry + Grafana | Vendor-neutral observability. Self-hostable. |

---

## Architecture Diagram

```
                    ┌─────────────────────────────────┐
                    │         Load Balancer            │
                    │       (Caddy / Fly Proxy)        │
                    └───────────┬──────────────────────┘
                                │
                    ┌───────────┴──────────────────────┐
                    │                                   │
              ┌─────▼─────┐                    ┌───────▼────────┐
              │  Next.js   │                    │   Hono API     │
              │  (Booking  │                    │   Server       │
              │   Pages)   │                    │   (REST API)   │
              │   :3000    │                    │   :4000        │
              └─────┬──────┘                    └───┬───┬───────┘
                    │                               │   │
                    │         ┌─────────────────────┘   │
                    │         │                         │
              ┌─────▼─────────▼──┐              ┌──────▼────────┐
              │   PostgreSQL     │              │    Redis       │
              │   (Primary DB)   │              │  (Cache/Queue) │
              │   :5432          │              │   :6379        │
              └──────────────────┘              └──────┬─────────┘
                                                       │
                                                ┌──────▼─────────┐
                                                │   BullMQ        │
                                                │   Workers       │
                                                │  ┌────────────┐ │
                                                │  │ Email Jobs  │ │
                                                │  │ SMS Jobs    │ │
                                                │  │ Webhook Jobs│ │
                                                │  │ Cal Sync    │ │
                                                │  └────────────┘ │
                                                └────────────────┘

              ┌─────────────┐          ┌─────────────────┐
              │  React SPA   │          │  External APIs   │
              │  (Dashboard) │          │  ┌─────────┐    │
              │  Static files│          │  │ Stripe   │    │
              │  served by   │          │  │ Twilio   │    │
              │  CDN/Caddy   │          │  │ Google   │    │
              └──────────────┘          │  │ Zoom     │    │
                                        │  │ Resend   │    │
                                        │  └─────────┘    │
                                        └─────────────────┘
```

---

## Multi-Tenancy Strategy

**Shared database, tenant isolation via `organization_id`.**

Every table (except `Organization` itself) has an `organization_id` column. All queries are scoped by organization.

Enforcement layers:
1. **API middleware**: Extracts `organization_id` from the authenticated user's session and injects it into the request context. Every database query includes this filter.
2. **PostgreSQL RLS** (Row-Level Security): Defense-in-depth. Even if application code has a bug, the database won't return rows from other tenants.
3. **API keys**: Scoped to an organization. The key lookup determines the tenant context.

```sql
-- Example RLS policy
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON bookings
  USING (organization_id = current_setting('app.current_org_id')::ulid);
```

---

## Availability Calculation Algorithm

The most complex piece of business logic. Given a service and optional employee, calculate available time slots for a date range.

```
function getAvailableSlots(serviceId, employeeId?, dateRange, timezone):

  1. Resolve employees
     - If employeeId given: use that employee
     - Else: get all employees assigned to this service

  2. For each employee, for each date in range:
     a. Get base availability (weekly schedule for that day-of-week)
     b. Apply overrides (blocked days, custom hours)
     c. Result: available time windows for that employee on that date

  3. For each available window:
     a. Generate candidate slots at interval = service.duration
        (e.g., 60-min service → 9:00, 10:00, 11:00, ...)
     b. For each candidate slot:
        - Check existing bookings for this employee (including buffers)
        - Check synced external calendar events (busy times)
        - Check organization min_notice_hours (no slots too soon)
        - Check organization max_advance_days (no slots too far out)
     c. Filter out conflicting slots

  4. Merge results across employees (if no specific employee chosen)
     - Group by time, attach available employee(s) to each slot
     - For auto-assign: just show the time, pick employee at booking time

  5. Return slots grouped by date

Performance optimization:
  - Cache employee bookings for the date range in a single query
  - Cache external calendar busy times (refresh every 5 min)
  - Pre-compute and cache "next available" for each service (for display)
```

---

## Project Directory Structure

```
booksmith/
├── README.md
├── docker-compose.yml              # Full stack for local dev / self-hosting
├── docs/                           # Product specs, wireframes, architecture
│
├── packages/
│   ├── api/                        # Hono REST API server
│   │   ├── src/
│   │   │   ├── index.ts            # Entry point
│   │   │   ├── app.ts              # Hono app setup, middleware
│   │   │   ├── routes/
│   │   │   │   ├── bookings.ts
│   │   │   │   ├── services.ts
│   │   │   │   ├── employees.ts
│   │   │   │   ├── customers.ts
│   │   │   │   ├── availability.ts
│   │   │   │   ├── booking-pages.ts
│   │   │   │   ├── payments.ts
│   │   │   │   ├── webhooks.ts
│   │   │   │   ├── analytics.ts
│   │   │   │   └── organization.ts
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts          # Session / API key auth
│   │   │   │   ├── tenant.ts        # Organization context injection
│   │   │   │   ├── rate-limit.ts
│   │   │   │   └── error-handler.ts
│   │   │   ├── services/            # Business logic layer
│   │   │   │   ├── booking.service.ts
│   │   │   │   ├── availability.service.ts
│   │   │   │   ├── notification.service.ts
│   │   │   │   ├── payment.service.ts
│   │   │   │   ├── calendar-sync.service.ts
│   │   │   │   └── webhook.service.ts
│   │   │   ├── db/
│   │   │   │   ├── schema.ts        # Drizzle schema (all tables)
│   │   │   │   ├── migrations/
│   │   │   │   └── seed.ts
│   │   │   └── lib/
│   │   │       ├── ulid.ts
│   │   │       ├── email.ts
│   │   │       └── sms.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── dashboard/                   # React SPA (admin UI)
│   │   ├── src/
│   │   │   ├── main.tsx
│   │   │   ├── routes/
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   ├── lib/
│   │   │   │   └── api-client.ts    # Typed API client
│   │   │   └── stores/
│   │   ├── package.json
│   │   └── vite.config.ts
│   │
│   ├── booking-page/                # Next.js (public booking pages)
│   │   ├── app/
│   │   │   ├── [slug]/
│   │   │   │   ├── page.tsx         # Service selection
│   │   │   │   ├── [service]/
│   │   │   │   │   └── page.tsx     # Date/time picker + confirmation
│   │   │   │   └── success/
│   │   │   │       └── page.tsx     # Booking success
│   │   │   └── layout.tsx
│   │   ├── package.json
│   │   └── next.config.ts
│   │
│   ├── widget/                      # Embeddable JS widget
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   └── widget.tsx           # Preact (tiny bundle)
│   │   ├── package.json
│   │   └── tsup.config.ts           # Bundle to single JS file
│   │
│   ├── workers/                     # BullMQ job processors
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── email.worker.ts
│   │   │   ├── sms.worker.ts
│   │   │   ├── webhook.worker.ts
│   │   │   └── calendar-sync.worker.ts
│   │   └── package.json
│   │
│   └── shared/                      # Shared types, utils, validation
│       ├── src/
│       │   ├── types.ts             # Shared TypeScript types
│       │   ├── validation.ts        # Zod schemas
│       │   └── constants.ts
│       └── package.json
│
├── package.json                     # Workspace root (npm workspaces)
├── turbo.json                       # Turborepo config
└── .github/
    └── workflows/
        └── ci.yml
```

---

## Key Design Decisions

### 1. Monorepo with npm workspaces + Turborepo
All packages in one repo for shared types, easier refactoring, and atomic deployments. Turborepo for parallel builds and caching.

### 2. Hono over Express/Fastify
Hono is lightweight (~14KB), TypeScript-native, and runs on Node, Bun, Deno, and Cloudflare Workers. This gives deployment flexibility without rewriting the API.

### 3. Separate booking page (Next.js) from dashboard (React SPA)
- Booking pages need SSR for SEO and fast first paint (customers find them via Google).
- Dashboard is a private SPA — no SEO needed, SPA gives better UX for complex interactions (calendar drag/drop, etc.).

### 4. BullMQ for async work
Notifications, calendar syncs, and webhook deliveries are async. BullMQ provides retries, backoff, dead-letter queues, and observability. Backed by the same Redis used for caching.

### 5. Widget built with Preact
The embeddable widget must be tiny (<30KB gzipped). Preact gives React's DX at 3KB. Bundled as a single JS file with tsup.

### 6. Self-host from day one
Docker Compose makes the full stack runnable with one command. This is a strong differentiator vs. Calendesk/Calendly and builds trust with privacy-conscious users.

---

## Deployment Targets

### Self-Hosted (Docker Compose)
```yaml
services:
  api:      # Hono API
  booking:  # Next.js booking pages
  workers:  # BullMQ workers
  postgres: # PostgreSQL
  redis:    # Redis
  caddy:    # Reverse proxy + auto HTTPS
```

### Managed Cloud (Fly.io)
- API + Workers: Fly Machines (auto-scale)
- Booking Pages: Fly Machines with edge routing
- Dashboard: Static deploy to Fly CDN (or Cloudflare Pages)
- PostgreSQL: Fly Postgres (or Neon for serverless)
- Redis: Fly Redis (Upstash for serverless)
