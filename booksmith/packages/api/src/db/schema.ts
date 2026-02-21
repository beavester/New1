import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  time,
  date,
  jsonb,
  index,
  unique,
  primaryKey,
} from "drizzle-orm/pg-core";

// ─── Organization ────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"),
  timezone: text("timezone").notNull().default("America/New_York"),
  currency: text("currency").notNull().default("USD"),
  locale: text("locale").notNull().default("en-US"),
  plan: text("plan").notNull().default("free"),
  stripeCustomerId: text("stripe_customer_id"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── User (Employee) ────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    avatarUrl: text("avatar_url"),
    phone: text("phone"),
    role: text("role").notNull().default("staff"),
    timezone: text("timezone"),
    isBookable: boolean("is_bookable").notNull().default(true),
    bio: text("bio"),
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("users_org_email").on(table.organizationId, table.email),
    index("users_org_idx").on(table.organizationId),
  ]
);

// ─── Customer ────────────────────────────────────────────

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    notes: text("notes"),
    tags: jsonb("tags").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("customers_org_email").on(table.organizationId, table.email),
    index("customers_org_idx").on(table.organizationId),
  ]
);

// ─── Service ─────────────────────────────────────────────

export const services = pgTable(
  "services",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    description: text("description"),
    slug: text("slug").notNull(),
    durationMins: integer("duration_mins").notNull(),
    bufferBeforeMins: integer("buffer_before_mins"),
    bufferAfterMins: integer("buffer_after_mins"),
    priceCents: integer("price_cents"),
    currency: text("currency"),
    depositCents: integer("deposit_cents"),
    color: text("color").notNull().default("#2563EB"),
    isGroup: boolean("is_group").notNull().default(false),
    maxParticipants: integer("max_participants"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("services_org_slug").on(table.organizationId, table.slug),
    index("services_org_idx").on(table.organizationId),
  ]
);

// ─── Service ↔ Employee (many-to-many) ──────────────────

export const serviceEmployees = pgTable(
  "service_employees",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    customPriceCents: integer("custom_price_cents"),
    customDurationMins: integer("custom_duration_mins"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.serviceId, table.userId] })]
);

// ─── Availability ────────────────────────────────────────

export const availability = pgTable(
  "availability",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("availability_user_idx").on(table.userId)]
);

// ─── Availability Override ───────────────────────────────

export const availabilityOverrides = pgTable(
  "availability_overrides",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    date: date("date").notNull(),
    isAvailable: boolean("is_available").notNull(),
    startTime: time("start_time"),
    endTime: time("end_time"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("overrides_user_date").on(table.userId, table.date),
    index("overrides_user_idx").on(table.userId),
  ]
);

// ─── Booking ─────────────────────────────────────────────

export const bookings = pgTable(
  "bookings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    status: text("status").notNull().default("pending"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timezone: text("timezone").notNull(),
    priceCents: integer("price_cents"),
    currency: text("currency"),
    paymentStatus: text("payment_status").notNull().default("none"),
    paymentIntentId: text("payment_intent_id"),
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    notes: text("notes"),
    internalNotes: text("internal_notes"),
    intakeData: jsonb("intake_data"),
    videoMeetingUrl: text("video_meeting_url"),
    source: text("source").notNull().default("booking_page"),
    recurringId: text("recurring_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bookings_org_starts_idx").on(
      table.organizationId,
      table.startsAt
    ),
    index("bookings_user_starts_idx").on(table.userId, table.startsAt),
    index("bookings_customer_idx").on(table.customerId),
    index("bookings_status_idx").on(table.status),
  ]
);

// ─── Recurring Booking ───────────────────────────────────

export const recurringBookings = pgTable(
  "recurring_bookings",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    frequency: text("frequency").notNull(),
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    startsFrom: date("starts_from").notNull(),
    endsOn: date("ends_on"),
    maxOccurrences: integer("max_occurrences"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("recurring_org_idx").on(table.organizationId)]
);

// ─── Booking Page ────────────────────────────────────────

export const bookingPages = pgTable(
  "booking_pages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    customDomain: text("custom_domain"),
    theme: jsonb("theme").notNull().default({}),
    seo: jsonb("seo").notNull().default({}),
    sections: jsonb("sections").notNull().default([]),
    services: jsonb("services").notNull().default([]),
    employees: jsonb("employees").notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("booking_pages_slug").on(table.slug),
    index("booking_pages_org_idx").on(table.organizationId),
  ]
);

// ─── Notification ────────────────────────────────────────

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    bookingId: text("booking_id").references(() => bookings.id),
    recipientType: text("recipient_type").notNull(),
    recipientEmail: text("recipient_email"),
    recipientPhone: text("recipient_phone"),
    channel: text("channel").notNull(),
    type: text("type").notNull(),
    subject: text("subject"),
    body: text("body").notNull(),
    status: text("status").notNull().default("queued"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("notifications_org_idx").on(table.organizationId),
    index("notifications_booking_idx").on(table.bookingId),
  ]
);

// ─── Calendar Sync ───────────────────────────────────────

export const calendarSyncs = pgTable(
  "calendar_syncs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    externalCalendarId: text("external_calendar_id").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    syncDirection: text("sync_direction").notNull().default("both"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("calendar_syncs_user_idx").on(table.userId)]
);

// ─── Webhook ─────────────────────────────────────────────

export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    url: text("url").notNull(),
    secret: text("secret").notNull(),
    events: jsonb("events").notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("webhooks_org_idx").on(table.organizationId)]
);

// ─── API Key ─────────────────────────────────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    prefix: text("prefix").notNull(),
    scopes: jsonb("scopes").notNull().default([]),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("api_keys_org_idx").on(table.organizationId),
    index("api_keys_prefix_idx").on(table.prefix),
  ]
);

// ─── Payment ─────────────────────────────────────────────

export const payments = pgTable(
  "payments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    bookingId: text("booking_id")
      .notNull()
      .references(() => bookings.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull(),
    provider: text("provider").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    status: text("status").notNull().default("pending"),
    refundAmountCents: integer("refund_amount_cents"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payments_org_idx").on(table.organizationId),
    index("payments_booking_idx").on(table.bookingId),
  ]
);
