import { Hono } from "hono";
import type { AppContext } from "../app";
import { updateOrganizationSchema } from "@booksmith/shared";

export const organizationRoutes = new Hono<AppContext>();

// GET /v1/organization
organizationRoutes.get("/", async (c) => {
  const orgId = c.get("organizationId");
  // TODO: Query organization
  return c.json({ id: orgId });
});

// PATCH /v1/organization
organizationRoutes.patch("/", async (c) => {
  const orgId = c.get("organizationId");
  const body = updateOrganizationSchema.parse(await c.req.json());
  // TODO: Update organization
  return c.json({ id: orgId });
});

// GET /v1/organization/billing
organizationRoutes.get("/billing", async (c) => {
  // TODO: Return billing info from Stripe
  return c.json({ plan: "free", usage: {} });
});

// POST /v1/organization/billing/portal
organizationRoutes.post("/billing/portal", async (c) => {
  // TODO: Create Stripe billing portal session
  return c.json({ url: "https://billing.stripe.com/..." });
});
