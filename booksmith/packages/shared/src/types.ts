// ─── Enums ───────────────────────────────────────────────

export type Plan = "free" | "starter" | "pro" | "business";

export type UserRole = "owner" | "admin" | "manager" | "staff";

export type BookingStatus =
  | "pending"
  | "confirmed"
  | "cancelled"
  | "no_show"
  | "completed";

export type PaymentStatus =
  | "none"
  | "pending"
  | "paid"
  | "refunded"
  | "partially_refunded";

export type CancelledBy = "customer" | "employee" | "admin" | "system";

export type BookingSource =
  | "booking_page"
  | "widget"
  | "api"
  | "admin"
  | "recurring";

export type RecurringFrequency = "weekly" | "biweekly" | "monthly";

export type NotificationChannel = "email" | "sms" | "push";

export type NotificationType =
  | "confirmation"
  | "reminder"
  | "cancellation"
  | "reschedule"
  | "follow_up"
  | "custom";

export type NotificationStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "failed"
  | "bounced";

export type CalendarProvider = "google" | "outlook" | "apple";

export type SyncDirection = "read" | "write" | "both";

export type PaymentProvider = "stripe" | "paypal" | "lemonsqueezy";

export type CancellationPolicy = "flexible" | "moderate" | "strict";

// ─── Entities ────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  timezone: string;
  currency: string;
  locale: string;
  plan: Plan;
  stripeCustomerId: string | null;
  settings: OrganizationSettings;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationSettings {
  bufferBeforeMins: number;
  bufferAfterMins: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  cancellationPolicy: CancellationPolicy;
  cancellationWindowHours: number;
}

export interface User {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  phone: string | null;
  role: UserRole;
  timezone: string | null;
  isBookable: boolean;
  bio: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Customer {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  phone: string | null;
  notes: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Service {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  slug: string;
  durationMins: number;
  bufferBeforeMins: number | null;
  bufferAfterMins: number | null;
  priceCents: number | null;
  currency: string | null;
  depositCents: number | null;
  color: string;
  isGroup: boolean;
  maxParticipants: number | null;
  isActive: boolean;
  sortOrder: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Availability {
  id: string;
  userId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface AvailabilityOverride {
  id: string;
  userId: string;
  date: string;
  isAvailable: boolean;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

export interface Booking {
  id: string;
  organizationId: string;
  serviceId: string;
  userId: string;
  customerId: string;
  status: BookingStatus;
  startsAt: string;
  endsAt: string;
  timezone: string;
  priceCents: number | null;
  currency: string | null;
  paymentStatus: PaymentStatus;
  paymentIntentId: string | null;
  cancellationReason: string | null;
  cancelledAt: string | null;
  cancelledBy: CancelledBy | null;
  notes: string | null;
  internalNotes: string | null;
  intakeData: Record<string, unknown> | null;
  videoMeetingUrl: string | null;
  source: BookingSource;
  recurringId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BookingPage {
  id: string;
  organizationId: string;
  slug: string;
  title: string;
  description: string | null;
  customDomain: string | null;
  theme: BookingPageTheme;
  seo: BookingPageSeo;
  sections: unknown[];
  services: string[];
  employees: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BookingPageTheme {
  primaryColor: string;
  font: string;
  logoUrl: string | null;
  coverImageUrl: string | null;
  showBranding: boolean;
}

export interface BookingPageSeo {
  title: string | null;
  description: string | null;
  ogImageUrl: string | null;
}

// ─── API Types ───────────────────────────────────────────

export interface PaginatedResponse<T> {
  data: T[];
  cursor: string | null;
  hasMore: boolean;
}

export interface AvailableSlot {
  start: string;
  end: string;
  employeeId: string;
}

export interface AvailabilityResponse {
  service: Pick<Service, "id" | "name" | "durationMins">;
  slots: {
    date: string;
    times: AvailableSlot[];
  }[];
}

export interface WebhookEvent {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}
