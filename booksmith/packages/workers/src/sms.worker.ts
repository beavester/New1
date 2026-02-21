import { Worker, type Job } from "bullmq";

interface SmsJobData {
  to: string;
  body: string;
  organizationId: string;
  notificationId: string;
}

export const smsWorker = new Worker<SmsJobData>(
  "sms",
  async (job: Job<SmsJobData>) => {
    const { to, body } = job.data;

    // TODO: Implement SMS sending via Twilio
    // 1. Load org's Twilio credentials (or use platform credentials)
    // 2. Send SMS via Twilio API
    // 3. Update notification record status

    console.log(`[sms] Sending to ${to}: "${body.slice(0, 50)}..."`);
  },
  {
    connection: { host: "localhost", port: 6379 },
    concurrency: 5,
  }
);

smsWorker.on("failed", (job, err) => {
  console.error(`[sms] Job ${job?.id} failed:`, err.message);
});
