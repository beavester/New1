# Booksmith — Data Models

All timestamps are UTC. All IDs are ULIDs (sortable, URL-safe).

---

## Core Entities

### Organization
The top-level tenant. Everything belongs to an organization.

```
Organization
├── id                  ULID
├── name                string
├── slug                string (unique, URL-safe — used in booksmith.app/{slug})
├── logo_url            string?
├── timezone            string (IANA, e.g. "America/New_York")
├── currency            string (ISO 4217, e.g. "USD")
├── locale              string (e.g. "en-US")
├── plan                enum (free, starter, pro, business)
├── stripe_customer_id  string?
├── settings            jsonb {
│     buffer_before_mins: int,
│     buffer_after_mins: int,
│     min_notice_hours: int,          // minimum advance booking time
│     max_advance_days: int,          // how far ahead clients can book
│     cancellation_policy: enum,      // flexible, moderate, strict
│     cancellation_window_hours: int,
│   }
├── created_at          timestamp
└── updated_at          timestamp
```

### User (Internal / Employee)
People who work at the organization — admins, managers, staff.

```
User
├── id                  ULID
├── organization_id     ULID → Organization
├── email               string (unique within org)
├── password_hash       string
├── name                string
├── avatar_url          string?
├── phone               string?
├── role                enum (owner, admin, manager, staff)
├── timezone            string? (override org default)
├── is_bookable         boolean (can clients book this person?)
├── bio                 text?
├── settings            jsonb {
│     email_notifications: boolean,
│     sms_notifications: boolean,
│     daily_digest: boolean,
│   }
├── created_at          timestamp
└── updated_at          timestamp
```

### Customer (External / Client)
People who book appointments.

```
Customer
├── id                  ULID
├── organization_id     ULID → Organization
├── email               string
├── name                string
├── phone               string?
├── notes               text? (internal, not visible to customer)
├── tags                string[]
├── metadata            jsonb (custom fields)
├── created_at          timestamp
└── updated_at          timestamp

UNIQUE(organization_id, email)
```

### Service
A bookable service offered by the organization.

```
Service
├── id                  ULID
├── organization_id     ULID → Organization
├── name                string (e.g. "60-min Consultation")
├── description         text?
├── slug                string (URL-safe)
├── duration_mins       int
├── buffer_before_mins  int? (override org default)
├── buffer_after_mins   int? (override org default)
├── price_cents         int? (null = free)
├── currency            string? (override org default)
├── deposit_cents       int? (partial prepayment)
├── color               string (hex, for calendar display)
├── is_group            boolean
├── max_participants    int? (for group bookings)
├── is_active           boolean
├── sort_order          int
├── metadata            jsonb (custom intake fields definition)
├── created_at          timestamp
└── updated_at          timestamp
```

### ServiceEmployee (many-to-many)
Which employees can perform which services.

```
ServiceEmployee
├── service_id          ULID → Service
├── user_id             ULID → User (employee)
├── custom_price_cents  int? (employee-specific pricing override)
├── custom_duration_mins int? (employee-specific duration override)
└── created_at          timestamp

PRIMARY KEY(service_id, user_id)
```

### Availability
Weekly recurring schedule for each employee.

```
Availability
├── id                  ULID
├── user_id             ULID → User
├── day_of_week         int (0=Monday, 6=Sunday)
├── start_time          time (e.g. "09:00")
├── end_time            time (e.g. "17:00")
├── created_at          timestamp
└── updated_at          timestamp

// Multiple rows per day = multiple time blocks (e.g. morning + afternoon with lunch break)
```

### AvailabilityOverride
Date-specific overrides (holidays, special hours, sick days).

```
AvailabilityOverride
├── id                  ULID
├── user_id             ULID → User
├── date                date
├── is_available        boolean (false = blocked day)
├── start_time          time? (if available, custom hours)
├── end_time            time?
├── reason              string? ("Holiday", "Sick", etc.)
├── created_at          timestamp
└── updated_at          timestamp
```

### Booking
The central entity — a scheduled appointment.

```
Booking
├── id                  ULID
├── organization_id     ULID → Organization
├── service_id          ULID → Service
├── user_id             ULID → User (assigned employee)
├── customer_id         ULID → Customer
├── status              enum (pending, confirmed, cancelled, no_show, completed)
├── starts_at           timestamp
├── ends_at             timestamp
├── timezone            string (customer's timezone at time of booking)
├── price_cents         int? (captured at booking time)
├── currency            string?
├── payment_status      enum (none, pending, paid, refunded, partially_refunded)
├── payment_intent_id   string? (Stripe PaymentIntent ID)
├── cancellation_reason text?
├── cancelled_at        timestamp?
├── cancelled_by        enum? (customer, employee, admin, system)
├── notes               text? (customer-provided notes)
├── internal_notes      text? (staff-only notes)
├── intake_data         jsonb? (custom field responses)
├── video_meeting_url   string? (Zoom/Meet/Teams link)
├── source              enum (booking_page, widget, api, admin, recurring)
├── recurring_id        ULID? → RecurringBooking
├── created_at          timestamp
└── updated_at          timestamp

INDEX(organization_id, starts_at)
INDEX(user_id, starts_at)
INDEX(customer_id)
INDEX(status)
```

### RecurringBooking
Template for recurring appointment series.

```
RecurringBooking
├── id                  ULID
├── organization_id     ULID → Organization
├── service_id          ULID → Service
├── user_id             ULID → User
├── customer_id         ULID → Customer
├── frequency           enum (weekly, biweekly, monthly)
├── day_of_week         int
├── start_time          time
├── starts_from         date
├── ends_on             date? (null = indefinite)
├── max_occurrences     int?
├── is_active           boolean
├── created_at          timestamp
└── updated_at          timestamp
```

### BookingPage
A public-facing booking page/website.

```
BookingPage
├── id                  ULID
├── organization_id     ULID → Organization
├── slug                string (URL path segment)
├── title               string
├── description         text?
├── custom_domain       string? (Pro+)
├── theme               jsonb {
│     primary_color: string,
│     font: string,
│     logo_url: string?,
│     cover_image_url: string?,
│     show_branding: boolean,
│   }
├── seo                 jsonb {
│     title: string?,
│     description: string?,
│     og_image_url: string?,
│   }
├── sections            jsonb[] (page builder content blocks)
├── services            ULID[] (which services to show, ordered)
├── employees           ULID[] (which employees to show)
├── is_active           boolean
├── created_at          timestamp
└── updated_at          timestamp
```

### Notification
Log of all notifications sent.

```
Notification
├── id                  ULID
├── organization_id     ULID → Organization
├── booking_id          ULID? → Booking
├── recipient_type      enum (customer, employee)
├── recipient_email     string?
├── recipient_phone     string?
├── channel             enum (email, sms, push)
├── type                enum (confirmation, reminder, cancellation, reschedule, follow_up, custom)
├── subject             string?
├── body                text
├── status              enum (queued, sent, delivered, failed, bounced)
├── sent_at             timestamp?
├── error               text?
├── created_at          timestamp
└── updated_at          timestamp
```

### CalendarSync
External calendar connections.

```
CalendarSync
├── id                  ULID
├── user_id             ULID → User
├── provider            enum (google, outlook, apple)
├── external_calendar_id string
├── access_token        string (encrypted)
├── refresh_token       string (encrypted)
├── sync_direction      enum (read, write, both)
├── last_synced_at      timestamp?
├── is_active           boolean
├── created_at          timestamp
└── updated_at          timestamp
```

### Webhook
Webhook subscriptions for API consumers.

```
Webhook
├── id                  ULID
├── organization_id     ULID → Organization
├── url                 string
├── secret              string (for HMAC signature verification)
├── events              string[] (e.g. ["booking.created", "booking.cancelled"])
├── is_active           boolean
├── last_triggered_at   timestamp?
├── failure_count       int
├── created_at          timestamp
└── updated_at          timestamp
```

### APIKey
```
APIKey
├── id                  ULID
├── organization_id     ULID → Organization
├── name                string (human-readable label)
├── key_hash            string (bcrypt hash — plaintext shown once at creation)
├── prefix              string (first 8 chars, for identification: "bks_live_a1b2...")
├── scopes              string[] (e.g. ["bookings:read", "bookings:write"])
├── last_used_at        timestamp?
├── expires_at          timestamp?
├── created_at          timestamp
└── updated_at          timestamp
```

### Payment
```
Payment
├── id                  ULID
├── organization_id     ULID → Organization
├── booking_id          ULID → Booking
├── customer_id         ULID → Customer
├── amount_cents        int
├── currency            string
├── provider            enum (stripe, paypal, lemonsqueezy)
├── provider_payment_id string
├── status              enum (pending, succeeded, failed, refunded)
├── refund_amount_cents int?
├── metadata            jsonb
├── created_at          timestamp
└── updated_at          timestamp
```

---

## Entity Relationship Diagram (Simplified)

```
Organization ──┬── User (employees)
               │    ├── Availability
               │    ├── AvailabilityOverride
               │    └── CalendarSync
               │
               ├── Customer
               │
               ├── Service
               │    └── ServiceEmployee ←→ User
               │
               ├── Booking
               │    ├── → Service
               │    ├── → User (assigned)
               │    ├── → Customer
               │    ├── → RecurringBooking?
               │    ├── Payment
               │    └── Notification
               │
               ├── BookingPage
               │
               ├── Webhook
               │
               └── APIKey
```

---

## Key Constraints

1. A booking's `starts_at`/`ends_at` must fall within the assigned employee's availability (weekly schedule + overrides) minus buffer times.
2. No overlapping bookings for the same employee (unless the service is a group booking).
3. Group bookings allow multiple customers for the same time slot, up to `max_participants`.
4. `Customer.email` is unique per organization but the same person can be a customer at multiple organizations.
5. Soft deletes are NOT used — cancelled bookings retain their status. Deleted services/employees are marked `is_active = false`.
6. All monetary values stored in cents (integer) to avoid floating-point issues.
