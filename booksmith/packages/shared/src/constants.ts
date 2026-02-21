// ─── Plan Limits ─────────────────────────────────────────

export const PLAN_LIMITS = {
  free: {
    maxEmployees: 1,
    maxServices: 1,
    maxBookingsPerMonth: 100,
    maxBookingPages: 1,
    maxEmailsPerMonth: 50,
    maxSmsPerMonth: 0,
    apiCallsPerDay: 1_000,
    whiteLabel: false,
    customDomain: false,
    groupBookings: false,
    recurringBookings: false,
    fileUploads: false,
    zapier: false,
    sso: false,
  },
  starter: {
    maxEmployees: 3,
    maxServices: Infinity,
    maxBookingsPerMonth: 500,
    maxBookingPages: 1,
    maxEmailsPerMonth: 200,
    maxSmsPerMonth: 50,
    apiCallsPerDay: 10_000,
    whiteLabel: false,
    customDomain: false,
    groupBookings: false,
    recurringBookings: true,
    fileUploads: false,
    zapier: false,
    sso: false,
  },
  pro: {
    maxEmployees: 15,
    maxServices: Infinity,
    maxBookingsPerMonth: Infinity,
    maxBookingPages: 5,
    maxEmailsPerMonth: 1_000,
    maxSmsPerMonth: 200,
    apiCallsPerDay: 100_000,
    whiteLabel: true,
    customDomain: true,
    groupBookings: true,
    recurringBookings: true,
    fileUploads: true,
    zapier: true,
    sso: false,
  },
  business: {
    maxEmployees: Infinity,
    maxServices: Infinity,
    maxBookingsPerMonth: Infinity,
    maxBookingPages: Infinity,
    maxEmailsPerMonth: Infinity,
    maxSmsPerMonth: Infinity,
    apiCallsPerDay: Infinity,
    whiteLabel: true,
    customDomain: true,
    groupBookings: true,
    recurringBookings: true,
    fileUploads: true,
    zapier: true,
    sso: true,
  },
} as const;

export type PlanLimits = (typeof PLAN_LIMITS)[keyof typeof PLAN_LIMITS];

// ─── Webhook Events ──────────────────────────────────────

export const WEBHOOK_EVENTS = [
  "booking.created",
  "booking.confirmed",
  "booking.cancelled",
  "booking.rescheduled",
  "booking.completed",
  "booking.no_show",
  "customer.created",
  "customer.updated",
  "customer.deleted",
  "payment.succeeded",
  "payment.failed",
  "payment.refunded",
  "employee.created",
  "employee.updated",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

// ─── Defaults ────────────────────────────────────────────

export const DEFAULT_ORG_SETTINGS = {
  bufferBeforeMins: 0,
  bufferAfterMins: 0,
  minNoticeHours: 1,
  maxAdvanceDays: 60,
  cancellationPolicy: "flexible" as const,
  cancellationWindowHours: 24,
};

export const DEFAULT_TIMEZONE = "America/New_York";
export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_LOCALE = "en-US";

// ─── Slot Generation ─────────────────────────────────────

export const SLOT_INTERVAL_MINS = 15; // Generate slots every 15 minutes
