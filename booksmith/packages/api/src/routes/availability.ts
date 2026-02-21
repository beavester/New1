import { Hono } from "hono";
import { availabilityQuerySchema } from "@booksmith/shared";

// Public route — no auth required
export const availabilityRoutes = new Hono();

// GET /v1/availability?service_id=...&employee_id=...&date=...&timezone=...
availabilityRoutes.get("/", async (c) => {
  const query = availabilityQuerySchema.parse({
    serviceId: c.req.query("service_id"),
    employeeId: c.req.query("employee_id"),
    date: c.req.query("date"),
    from: c.req.query("from"),
    to: c.req.query("to"),
    timezone: c.req.query("timezone"),
  });

  // TODO: Call calculateAvailableSlots() from availability.service.ts
  // 1. Load service details (duration, buffers)
  // 2. Load employee schedules + overrides
  // 3. Load existing bookings for date range
  // 4. Load external calendar busy times
  // 5. Run the slot calculation algorithm
  // 6. Return grouped by date

  return c.json({
    service: { id: query.serviceId, name: "placeholder", durationMins: 60 },
    slots: [],
  });
});
