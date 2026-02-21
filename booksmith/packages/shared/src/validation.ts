import { z } from "zod";

// ─── Common ──────────────────────────────────────────────

export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

// ─── Service ─────────────────────────────────────────────

export const createServiceSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  durationMins: z.number().int().min(5).max(480),
  bufferBeforeMins: z.number().int().min(0).max(120).optional(),
  bufferAfterMins: z.number().int().min(0).max(120).optional(),
  priceCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  depositCents: z.number().int().min(0).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  isGroup: z.boolean().default(false),
  maxParticipants: z.number().int().min(2).max(500).optional(),
});

export const updateServiceSchema = createServiceSchema.partial();

// ─── Employee ────────────────────────────────────────────

export const createEmployeeSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  phone: z.string().max(30).optional(),
  role: z.enum(["admin", "manager", "staff"]).default("staff"),
  isBookable: z.boolean().default(true),
  bio: z.string().max(2000).optional(),
});

export const updateEmployeeSchema = createEmployeeSchema.partial();

// ─── Availability ────────────────────────────────────────

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const availabilityBlockSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeSchema,
  endTime: timeSchema,
});

export const setAvailabilitySchema = z.object({
  blocks: z.array(availabilityBlockSchema),
});

export const createOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isAvailable: z.boolean(),
  startTime: timeSchema.optional(),
  endTime: timeSchema.optional(),
  reason: z.string().max(200).optional(),
});

// ─── Customer ────────────────────────────────────────────

export const createCustomerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  phone: z.string().max(30).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export const updateCustomerSchema = createCustomerSchema.partial();

// ─── Booking ─────────────────────────────────────────────

export const createBookingSchema = z.object({
  serviceId: ulidSchema,
  employeeId: ulidSchema.optional(),
  startsAt: z.string().datetime(),
  customer: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    phone: z.string().max(30).optional(),
  }),
  notes: z.string().max(2000).optional(),
  intakeData: z.record(z.unknown()).optional(),
  timezone: z.string().min(1),
});

export const cancelBookingSchema = z.object({
  reason: z.string().max(1000).optional(),
});

export const rescheduleBookingSchema = z.object({
  startsAt: z.string().datetime(),
  employeeId: ulidSchema.optional(),
});

// ─── Availability Query ──────────────────────────────────

export const availabilityQuerySchema = z.object({
  serviceId: ulidSchema,
  employeeId: ulidSchema.optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timezone: z.string().default("UTC"),
});

// ─── Webhook ─────────────────────────────────────────────

export const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string()).min(1),
});

export const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).min(1).optional(),
  isActive: z.boolean().optional(),
});

// ─── Organization ────────────────────────────────────────

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  timezone: z.string().optional(),
  currency: z.string().length(3).optional(),
  locale: z.string().max(10).optional(),
  settings: z
    .object({
      bufferBeforeMins: z.number().int().min(0).max(120).optional(),
      bufferAfterMins: z.number().int().min(0).max(120).optional(),
      minNoticeHours: z.number().int().min(0).max(720).optional(),
      maxAdvanceDays: z.number().int().min(1).max(365).optional(),
      cancellationPolicy: z
        .enum(["flexible", "moderate", "strict"])
        .optional(),
      cancellationWindowHours: z.number().int().min(0).max(168).optional(),
    })
    .optional(),
});
