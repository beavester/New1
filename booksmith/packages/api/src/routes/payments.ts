import { Hono } from "hono";
import type { AppContext } from "../app";

export const paymentsRoutes = new Hono<AppContext>();

paymentsRoutes.get("/", async (c) => {
  return c.json({ data: [], cursor: null, hasMore: false });
});

paymentsRoutes.get("/:id", async (c) => {
  return c.json({ id: c.req.param("id") });
});

paymentsRoutes.post("/:id/refund", async (c) => {
  const paymentId = c.req.param("id");
  const { amountCents } = await c.req.json();
  // TODO: Process refund via Stripe/PayPal
  return c.json({ id: paymentId, status: "refunded" });
});
