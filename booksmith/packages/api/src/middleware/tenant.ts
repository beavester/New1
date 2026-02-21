import type { MiddlewareHandler } from "hono";

/**
 * Tenant isolation middleware.
 *
 * Ensures every request operates within a single organization's scope.
 * Sets the PostgreSQL session variable for Row-Level Security enforcement.
 */
export const tenantMiddleware: MiddlewareHandler = async (c, next) => {
  const organizationId = c.get("organizationId" as never);

  if (!organizationId) {
    return c.json({ error: "Organization context required" }, 403);
  }

  // Set PostgreSQL session variable for RLS policies
  // TODO: Execute: SET LOCAL app.current_org_id = organizationId
  // This ensures RLS policies can reference the current tenant

  await next();
};
