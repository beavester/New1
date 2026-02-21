import { Hono } from "hono";
import type { AppContext } from "../app";
import { createWebhookSchema, updateWebhookSchema } from "@booksmith/shared";

export const webhooksRoutes = new Hono<AppContext>();

webhooksRoutes.get("/", async (c) => {
  return c.json({ data: [] });
});

webhooksRoutes.post("/", async (c) => {
  const body = createWebhookSchema.parse(await c.req.json());
  // TODO: Generate secret, insert webhook
  return c.json({ id: "placeholder", secret: "whsec_..." }, 201);
});

webhooksRoutes.get("/:id", async (c) => {
  return c.json({ id: c.req.param("id") });
});

webhooksRoutes.patch("/:id", async (c) => {
  const body = updateWebhookSchema.parse(await c.req.json());
  return c.json({ id: c.req.param("id") });
});

webhooksRoutes.delete("/:id", async (c) => {
  return c.body(null, 204);
});

webhooksRoutes.post("/:id/test", async (c) => {
  // TODO: Send test event to webhook URL
  return c.json({ delivered: true });
});
