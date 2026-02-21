import { Hono } from "hono";
import type { AppContext } from "../app";
import { createCustomerSchema, updateCustomerSchema } from "@booksmith/shared";

export const customersRoutes = new Hono<AppContext>();

customersRoutes.get("/", async (c) => {
  const orgId = c.get("organizationId");
  const search = c.req.query("search");
  const tag = c.req.query("tag");
  return c.json({ data: [], cursor: null, hasMore: false });
});

customersRoutes.post("/", async (c) => {
  const orgId = c.get("organizationId");
  const body = createCustomerSchema.parse(await c.req.json());
  return c.json({ id: "placeholder" }, 201);
});

customersRoutes.get("/:id", async (c) => {
  return c.json({ id: c.req.param("id") });
});

customersRoutes.patch("/:id", async (c) => {
  const body = updateCustomerSchema.parse(await c.req.json());
  return c.json({ id: c.req.param("id") });
});

customersRoutes.delete("/:id", async (c) => {
  // GDPR deletion
  return c.body(null, 204);
});

customersRoutes.get("/:id/bookings", async (c) => {
  return c.json({ data: [], cursor: null, hasMore: false });
});

customersRoutes.post("/export", async (c) => {
  // TODO: Generate CSV, return download URL
  return c.json({ downloadUrl: "placeholder" });
});

customersRoutes.post("/import", async (c) => {
  // TODO: Parse CSV upload, create customers
  return c.json({ imported: 0, errors: [] });
});
