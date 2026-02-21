import { Hono } from "hono";

// Public routes — powers the customer-facing booking experience
export const bookingPagesRoutes = new Hono();

// GET /v1/book/:slug — Get booking page config
bookingPagesRoutes.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  // TODO: Load booking page + organization + services + employees
  return c.json({
    slug,
    title: "placeholder",
    theme: {},
    services: [],
    employees: [],
  });
});

// GET /v1/book/:slug/availability — Get available slots for this page
bookingPagesRoutes.get("/:slug/availability", async (c) => {
  const slug = c.req.param("slug");
  const serviceId = c.req.query("service_id");
  const employeeId = c.req.query("employee_id");
  const date = c.req.query("date");
  const timezone = c.req.query("timezone") ?? "UTC";

  // TODO: Reuse availability calculation, scoped to this booking page's services/employees
  return c.json({ slots: [] });
});

// POST /v1/book/:slug/bookings — Create a booking (customer-facing)
bookingPagesRoutes.post("/:slug/bookings", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json();

  // TODO:
  // 1. Validate service/slot
  // 2. Find or create customer
  // 3. Create booking
  // 4. Initiate payment if required
  // 5. Return booking confirmation

  return c.json({ id: "placeholder", status: "confirmed" }, 201);
});

// GET /v1/book/:slug/bookings/:id — Get booking status
bookingPagesRoutes.get("/:slug/bookings/:id", async (c) => {
  const bookingId = c.req.param("id");
  return c.json({ id: bookingId, status: "confirmed" });
});

// POST /v1/book/:slug/bookings/:id/cancel — Cancel booking (with token)
bookingPagesRoutes.post("/:slug/bookings/:id/cancel", async (c) => {
  const bookingId = c.req.param("id");
  const { token, reason } = await c.req.json();

  // TODO: Verify cancellation token (sent via email) then cancel
  return c.json({ id: bookingId, status: "cancelled" });
});
