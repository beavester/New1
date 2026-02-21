import { Hono } from "hono";
import type { AppContext } from "../app";
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  setAvailabilitySchema,
  createOverrideSchema,
} from "@booksmith/shared";

export const employeesRoutes = new Hono<AppContext>();

// GET /v1/employees
employeesRoutes.get("/", async (c) => {
  const orgId = c.get("organizationId");
  return c.json({ data: [], cursor: null, hasMore: false });
});

// POST /v1/employees
employeesRoutes.post("/", async (c) => {
  const orgId = c.get("organizationId");
  const body = createEmployeeSchema.parse(await c.req.json());
  // TODO: Create user, send invite email
  return c.json({ id: "placeholder" }, 201);
});

// GET /v1/employees/:id
employeesRoutes.get("/:id", async (c) => {
  const employeeId = c.req.param("id");
  return c.json({ id: employeeId });
});

// PATCH /v1/employees/:id
employeesRoutes.patch("/:id", async (c) => {
  const employeeId = c.req.param("id");
  const body = updateEmployeeSchema.parse(await c.req.json());
  return c.json({ id: employeeId });
});

// DELETE /v1/employees/:id
employeesRoutes.delete("/:id", async (c) => {
  return c.body(null, 204);
});

// GET /v1/employees/:id/availability
employeesRoutes.get("/:id/availability", async (c) => {
  const employeeId = c.req.param("id");
  // TODO: Query availability blocks for employee
  return c.json({ blocks: [] });
});

// PUT /v1/employees/:id/availability
employeesRoutes.put("/:id/availability", async (c) => {
  const employeeId = c.req.param("id");
  const body = setAvailabilitySchema.parse(await c.req.json());
  // TODO: Delete existing, insert new blocks (full replace)
  return c.json({ blocks: body.blocks });
});

// GET /v1/employees/:id/overrides
employeesRoutes.get("/:id/overrides", async (c) => {
  const employeeId = c.req.param("id");
  return c.json({ data: [] });
});

// POST /v1/employees/:id/overrides
employeesRoutes.post("/:id/overrides", async (c) => {
  const employeeId = c.req.param("id");
  const body = createOverrideSchema.parse(await c.req.json());
  return c.json({ id: "placeholder" }, 201);
});

// DELETE /v1/employees/:id/overrides/:oid
employeesRoutes.delete("/:id/overrides/:oid", async (c) => {
  return c.body(null, 204);
});

// GET /v1/employees/:id/bookings
employeesRoutes.get("/:id/bookings", async (c) => {
  const employeeId = c.req.param("id");
  return c.json({ data: [], cursor: null, hasMore: false });
});
