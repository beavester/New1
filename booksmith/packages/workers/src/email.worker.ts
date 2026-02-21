import { Worker, type Job } from "bullmq";

interface EmailJobData {
  to: string;
  subject: string;
  templateId: string;
  variables: Record<string, string>;
  organizationId: string;
  notificationId: string;
}

export const emailWorker = new Worker<EmailJobData>(
  "email",
  async (job: Job<EmailJobData>) => {
    const { to, subject, templateId, variables } = job.data;

    // TODO: Implement email sending
    // 1. Load email template by templateId
    // 2. Render template with variables (React Email)
    // 3. Send via Resend (or SMTP for self-hosted)
    // 4. Update notification record status to 'sent' or 'failed'

    console.log(`[email] Sending "${subject}" to ${to}`);
  },
  {
    connection: { host: "localhost", port: 6379 },
    concurrency: 10,
  }
);

emailWorker.on("completed", (job) => {
  console.log(`[email] Job ${job.id} completed`);
});

emailWorker.on("failed", (job, err) => {
  console.error(`[email] Job ${job?.id} failed:`, err.message);
});
