import { Worker, type Job } from "bullmq";

interface CalendarSyncJobData {
  action: "create" | "update" | "delete" | "full_sync";
  bookingId?: string;
  userId: string;
  calendarSyncId: string;
}

export const calendarSyncWorker = new Worker<CalendarSyncJobData>(
  "calendar-sync",
  async (job: Job<CalendarSyncJobData>) => {
    const { action, bookingId, userId, calendarSyncId } = job.data;

    // TODO: Implement calendar sync
    // 1. Load CalendarSync record (provider, tokens)
    // 2. Refresh access token if expired
    // 3. Based on action:
    //    - create: Create event in external calendar
    //    - update: Update event in external calendar
    //    - delete: Delete event from external calendar
    //    - full_sync: Fetch all events from external calendar,
    //                 update local busy-time cache

    console.log(
      `[calendar-sync] ${action} for user ${userId}, booking ${bookingId ?? "n/a"}`
    );
  },
  {
    connection: { host: "localhost", port: 6379 },
    concurrency: 5,
  }
);

calendarSyncWorker.on("failed", (job, err) => {
  console.error(`[calendar-sync] Job ${job?.id} failed:`, err.message);
});
