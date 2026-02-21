/**
 * Availability Service
 *
 * Core business logic for calculating available booking slots.
 * This is the most complex piece of the system — it combines:
 *   1. Employee weekly schedules
 *   2. Date-specific overrides
 *   3. Existing bookings (with buffer times)
 *   4. External calendar busy times
 *   5. Organization-level constraints (min notice, max advance)
 */

import type { AvailableSlot } from "@booksmith/shared";
import { SLOT_INTERVAL_MINS } from "@booksmith/shared";

// ─── Types ───────────────────────────────────────────────

interface TimeBlock {
  start: number; // minutes from midnight
  end: number;
}

interface EmployeeSchedule {
  userId: string;
  weeklyBlocks: Map<number, TimeBlock[]>; // dayOfWeek → blocks
  overrides: Map<string, { isAvailable: boolean; block?: TimeBlock }>; // date string → override
}

interface ExistingBooking {
  userId: string;
  startsAt: Date;
  endsAt: Date;
}

interface SlotCalculationParams {
  serviceDurationMins: number;
  bufferBeforeMins: number;
  bufferAfterMins: number;
  minNoticeHours: number;
  maxAdvanceDays: number;
  employeeSchedules: EmployeeSchedule[];
  existingBookings: ExistingBooking[];
  externalBusyTimes: ExistingBooking[]; // same shape — userId + time range
  dateRange: { from: Date; to: Date };
  timezone: string;
}

// ─── Helpers ─────────────────────────────────────────────

function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60)
    .toString()
    .padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function dateToString(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getDayOfWeek(date: Date): number {
  // Convert JS day (0=Sun) to our format (0=Mon)
  const jsDay = date.getDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function getDateRange(from: Date, to: Date): Date[] {
  const dates: Date[] = [];
  const current = new Date(from);
  while (current <= to) {
    dates.push(new Date(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

// ─── Core Algorithm ──────────────────────────────────────

export function calculateAvailableSlots(
  params: SlotCalculationParams
): Map<string, AvailableSlot[]> {
  const {
    serviceDurationMins,
    bufferBeforeMins,
    bufferAfterMins,
    minNoticeHours,
    maxAdvanceDays,
    employeeSchedules,
    existingBookings,
    externalBusyTimes,
    dateRange,
  } = params;

  const now = new Date();
  const earliestStart = new Date(
    now.getTime() + minNoticeHours * 60 * 60 * 1000
  );
  const latestDate = new Date(
    now.getTime() + maxAdvanceDays * 24 * 60 * 60 * 1000
  );

  // Clamp date range
  const effectiveFrom =
    dateRange.from > earliestStart ? dateRange.from : earliestStart;
  const effectiveTo = dateRange.to < latestDate ? dateRange.to : latestDate;

  if (effectiveFrom > effectiveTo) {
    return new Map();
  }

  // Index existing bookings by employee + date for fast lookup
  const bookingIndex = new Map<string, TimeBlock[]>();
  for (const booking of [...existingBookings, ...externalBusyTimes]) {
    const dateStr = dateToString(booking.startsAt);
    const key = `${booking.userId}:${dateStr}`;
    if (!bookingIndex.has(key)) {
      bookingIndex.set(key, []);
    }
    bookingIndex.get(key)!.push({
      start:
        booking.startsAt.getHours() * 60 + booking.startsAt.getMinutes(),
      end: booking.endsAt.getHours() * 60 + booking.endsAt.getMinutes(),
    });
  }

  const result = new Map<string, AvailableSlot[]>();
  const dates = getDateRange(effectiveFrom, effectiveTo);

  for (const date of dates) {
    const dateStr = dateToString(date);
    const dayOfWeek = getDayOfWeek(date);
    const slotsForDate: AvailableSlot[] = [];

    for (const schedule of employeeSchedules) {
      // Check for date-specific override
      const override = schedule.overrides.get(dateStr);

      let availableBlocks: TimeBlock[];

      if (override) {
        if (!override.isAvailable) {
          continue; // Employee blocked this day
        }
        availableBlocks = override.block ? [override.block] : [];
      } else {
        // Use weekly schedule
        availableBlocks = schedule.weeklyBlocks.get(dayOfWeek) ?? [];
      }

      // For each available block, generate candidate slots
      const totalSlotDuration =
        bufferBeforeMins + serviceDurationMins + bufferAfterMins;
      const employeeBookings =
        bookingIndex.get(`${schedule.userId}:${dateStr}`) ?? [];

      for (const block of availableBlocks) {
        let slotStart = block.start;

        while (slotStart + totalSlotDuration <= block.end) {
          const serviceStart = slotStart + bufferBeforeMins;
          const serviceEnd = serviceStart + serviceDurationMins;
          const slotEnd = serviceEnd + bufferAfterMins;

          // Check for conflicts with existing bookings (including their buffers)
          const hasConflict = employeeBookings.some(
            (booking) => serviceStart < booking.end && serviceEnd > booking.start
          );

          if (!hasConflict) {
            // Check min notice for today's slots
            if (dateStr === dateToString(now)) {
              const nowMins = now.getHours() * 60 + now.getMinutes();
              const minNoticeMins = minNoticeHours * 60;
              if (serviceStart < nowMins + minNoticeMins) {
                slotStart += SLOT_INTERVAL_MINS;
                continue;
              }
            }

            slotsForDate.push({
              start: minutesToTime(serviceStart),
              end: minutesToTime(serviceEnd),
              employeeId: schedule.userId,
            });
          }

          slotStart += SLOT_INTERVAL_MINS;
        }
      }
    }

    if (slotsForDate.length > 0) {
      // Sort by time
      slotsForDate.sort((a, b) => a.start.localeCompare(b.start));
      result.set(dateStr, slotsForDate);
    }
  }

  return result;
}
