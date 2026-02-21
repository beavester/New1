import { emailWorker } from "./email.worker";
import { smsWorker } from "./sms.worker";
import { webhookWorker } from "./webhook.worker";
import { calendarSyncWorker } from "./calendar-sync.worker";

console.log("Booksmith workers starting...");

// All workers run in the same process for simplicity.
// In production, they can be split into separate processes for independent scaling.

const workers = [emailWorker, smsWorker, webhookWorker, calendarSyncWorker];

process.on("SIGTERM", async () => {
  console.log("Shutting down workers...");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
});

console.log(
  `${workers.length} workers running: email, sms, webhook, calendar-sync`
);
