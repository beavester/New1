import { Worker, type Job } from "bullmq";
import { createHmac } from "node:crypto";

interface WebhookJobData {
  webhookId: string;
  url: string;
  secret: string;
  event: {
    id: string;
    type: string;
    createdAt: string;
    data: Record<string, unknown>;
  };
}

export const webhookWorker = new Worker<WebhookJobData>(
  "webhook",
  async (job: Job<WebhookJobData>) => {
    const { url, secret, event } = job.data;
    const payload = JSON.stringify(event);

    // HMAC-SHA256 signature
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Booksmith-Signature": signature,
        "X-Booksmith-Event": event.type,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000), // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`Webhook delivery failed: ${response.status}`);
    }

    // TODO: Update webhook.lastTriggeredAt, reset failureCount
  },
  {
    connection: { host: "localhost", port: 6379 },
    concurrency: 20,
    settings: {
      backoffStrategy: (attemptsMade) => {
        // Exponential backoff: 10s, 30s, 90s, 270s, 810s
        return Math.min(10_000 * Math.pow(3, attemptsMade - 1), 900_000);
      },
    },
  }
);

webhookWorker.on("failed", (job, err) => {
  console.error(`[webhook] Job ${job?.id} failed:`, err.message);
  // TODO: Increment webhook.failureCount
  // If failureCount > 10, disable the webhook and notify the org admin
});
