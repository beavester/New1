import { Hono } from "hono";
import type { AppContext } from "../app";

export const analyticsRoutes = new Hono<AppContext>();

// GET /v1/analytics/overview
analyticsRoutes.get("/overview", async (c) => {
  const orgId = c.get("organizationId");
  const from = c.req.query("from");
  const to = c.req.query("to");

  // TODO: Aggregate queries
  return c.json({
    totalBookings: 0,
    totalRevenueCents: 0,
    noShowRate: 0,
    newCustomers: 0,
  });
});

// GET /v1/analytics/bookings — Booking volume over time
analyticsRoutes.get("/bookings", async (c) => {
  return c.json({ data: [] });
});

// GET /v1/analytics/revenue — Revenue over time
analyticsRoutes.get("/revenue", async (c) => {
  return c.json({ data: [] });
});

// GET /v1/analytics/services — Service popularity
analyticsRoutes.get("/services", async (c) => {
  return c.json({ data: [] });
});

// GET /v1/analytics/employees — Employee utilization
analyticsRoutes.get("/employees", async (c) => {
  return c.json({ data: [] });
});

// GET /v1/analytics/heatmap — Busiest hours/days
analyticsRoutes.get("/heatmap", async (c) => {
  return c.json({ data: [] });
});
