import { Hono } from "hono";
import type { AppContext } from "../app";
import {
  createBookingSchema,
  cancelBookingSchema,
  rescheduleBookingSchema,
  paginationSchema,
} from "@booksmith/shared";

export const bookingsRoutes = new Hono<AppContext>();

// GET /v1/bookings — List bookings
bookingsRoutes.get("/", async (c) => {
  const orgId = c.get("organizationId");
  const { cursor, limit } = paginationSchema.parse(c.req.query());
  const status = c.req.query("status");
  const employeeId = c.req.query("employee_id");
  const serviceId = c.req.query("service_id");
  const from = c.req.query("from");
  const to = c.req.query("to");

  // TODO: Query bookings with filters
  return c.json({ data: [], cursor: null, hasMore: false });
});

// POST /v1/bookings — Create booking
bookingsRoutes.post("/", async (c) => {
  const orgId = c.get("organizationId");
  const body = createBookingSchema.parse(await c.req.json());

  // TODO: Call BookingService.createBooking()
  return c.json({ id: "placeholder", status: "confirmed" }, 201);
});

// GET /v1/bookings/:id — Get booking
bookingsRoutes.get("/:id", async (c) => {
  const orgId = c.get("organizationId");
  const bookingId = c.req.param("id");

  // TODO: Query booking by ID, scoped to org
  return c.json({ id: bookingId });
});

// PATCH /v1/bookings/:id — Update booking
bookingsRoutes.patch("/:id", async (c) => {
  const orgId = c.get("organizationId");
  const bookingId = c.req.param("id");
  const body = await c.req.json();

  // TODO: Update booking fields (notes, internal notes, etc.)
  return c.json({ id: bookingId });
});

// POST /v1/bookings/:id/cancel — Cancel booking
bookingsRoutes.post("/:id/cancel", async (c) => {
  const orgId = c.get("organizationId");
  const bookingId = c.req.param("id");
  const body = cancelBookingSchema.parse(await c.req.json());

  // TODO: Call BookingService.cancelBooking()
  return c.json({ id: bookingId, status: "cancelled" });
});

// POST /v1/bookings/:id/confirm — Confirm pending booking
bookingsRoutes.post("/:id/confirm", async (c) => {
  const bookingId = c.req.param("id");

  // TODO: Update status to confirmed
  return c.json({ id: bookingId, status: "confirmed" });
});

// POST /v1/bookings/:id/complete — Mark as completed
bookingsRoutes.post("/:id/complete", async (c) => {
  const bookingId = c.req.param("id");

  // TODO: Call BookingService.completeBooking()
  return c.json({ id: bookingId, status: "completed" });
});

// POST /v1/bookings/:id/no-show — Mark as no-show
bookingsRoutes.post("/:id/no-show", async (c) => {
  const bookingId = c.req.param("id");

  // TODO: Call BookingService.markNoShow()
  return c.json({ id: bookingId, status: "no_show" });
});
