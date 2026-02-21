import { Hono } from "hono";
import type { AppContext } from "../app";
import {
  createServiceSchema,
  updateServiceSchema,
  paginationSchema,
} from "@booksmith/shared";

export const servicesRoutes = new Hono<AppContext>();

// GET /v1/services
servicesRoutes.get("/", async (c) => {
  const orgId = c.get("organizationId");
  // TODO: Query services for this org
  return c.json({ data: [], cursor: null, hasMore: false });
});

// POST /v1/services
servicesRoutes.post("/", async (c) => {
  const orgId = c.get("organizationId");
  const body = createServiceSchema.parse(await c.req.json());
  // TODO: Insert service
  return c.json({ id: "placeholder" }, 201);
});

// GET /v1/services/:id
servicesRoutes.get("/:id", async (c) => {
  const orgId = c.get("organizationId");
  const serviceId = c.req.param("id");
  // TODO: Query service by ID
  return c.json({ id: serviceId });
});

// PATCH /v1/services/:id
servicesRoutes.patch("/:id", async (c) => {
  const orgId = c.get("organizationId");
  const serviceId = c.req.param("id");
  const body = updateServiceSchema.parse(await c.req.json());
  // TODO: Update service
  return c.json({ id: serviceId });
});

// DELETE /v1/services/:id
servicesRoutes.delete("/:id", async (c) => {
  const serviceId = c.req.param("id");
  // TODO: Set is_active = false
  return c.body(null, 204);
});

// GET /v1/services/:id/employees
servicesRoutes.get("/:id/employees", async (c) => {
  const serviceId = c.req.param("id");
  // TODO: Query service_employees join
  return c.json({ data: [] });
});

// POST /v1/services/:id/employees
servicesRoutes.post("/:id/employees", async (c) => {
  const serviceId = c.req.param("id");
  const body = await c.req.json();
  // TODO: Insert service_employee
  return c.json({}, 201);
});

// DELETE /v1/services/:id/employees/:uid
servicesRoutes.delete("/:id/employees/:uid", async (c) => {
  // TODO: Delete service_employee
  return c.body(null, 204);
});
