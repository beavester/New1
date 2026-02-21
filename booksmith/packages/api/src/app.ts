import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { errorHandler } from "./middleware/error-handler";
import { authMiddleware } from "./middleware/auth";
import { tenantMiddleware } from "./middleware/tenant";
import { rateLimiter } from "./middleware/rate-limit";
import { servicesRoutes } from "./routes/services";
import { employeesRoutes } from "./routes/employees";
import { customersRoutes } from "./routes/customers";
import { bookingsRoutes } from "./routes/bookings";
import { availabilityRoutes } from "./routes/availability";
import { bookingPagesRoutes } from "./routes/booking-pages";
import { paymentsRoutes } from "./routes/payments";
import { webhooksRoutes } from "./routes/webhooks";
import { analyticsRoutes } from "./routes/analytics";
import { organizationRoutes } from "./routes/organization";

// ─── App Context Type ────────────────────────────────────

export type AppContext = {
  Variables: {
    userId: string;
    organizationId: string;
    userRole: string;
  };
};

// ─── App Setup ───────────────────────────────────────────

const app = new Hono<AppContext>();

// Global middleware
app.use("*", logger());
app.use("*", cors());
app.use("*", errorHandler);

// Health check (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));

// Public booking API (no auth — for customer-facing pages)
app.route("/v1/book", bookingPagesRoutes);
app.route("/v1/availability", availabilityRoutes);

// Authenticated API
app.use("/v1/*", rateLimiter);
app.use("/v1/*", authMiddleware);
app.use("/v1/*", tenantMiddleware);

app.route("/v1/services", servicesRoutes);
app.route("/v1/employees", employeesRoutes);
app.route("/v1/customers", customersRoutes);
app.route("/v1/bookings", bookingsRoutes);
app.route("/v1/payments", paymentsRoutes);
app.route("/v1/webhooks", webhooksRoutes);
app.route("/v1/analytics", analyticsRoutes);
app.route("/v1/organization", organizationRoutes);

export { app };
