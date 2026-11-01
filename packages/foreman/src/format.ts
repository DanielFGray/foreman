import { DateTime, Duration } from "effect";
import { exhausted, freeAt, type Usage } from "./quota.ts";

/**
 * When a window's allowance resets, as "in 37m at 11:23 PM".
 *
 * Relative alone goes stale as a report sits on screen; absolute alone hides
 * the distance that decides whether the fleet is down for an hour or a week.
 * The date appears only when the reset is not today, because a reset a day
 * out is ambiguous without it while one this evening is not.
 */
export const resetsLabel = (at: Date, now: Date = new Date()): string => {
  const minutes = Math.max(1, Math.ceil((at.getTime() - now.getTime()) / 60000));
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return `in ${Duration.format(Duration.minutes(minutes))} at ${DateTime.formatLocal(
    DateTime.makeUnsafe(at),
    {
      ...(sameDay ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    },
  )}`;
};

/**
 * A window's spent share as a whole percent, "28%".
 *
 * Providers report fractions — cursor derives its figure from a ratio — and a
 * column of fourteen-digit decimals is unreadable. Rounded down, because the
 * gate walls a window at 100: a display that rounds 99.6 up would show a spent
 * account the fleet is still dispatching to.
 */
export const usedLabel = (usedPercent: number): string => `${Math.floor(usedPercent)}%`;

/** One provider's quota reading, read or unreadable. */
export type QuotaReading =
  | { readonly _tag: "usage"; readonly provider: string; readonly usage: Usage }
  | { readonly _tag: "unreadable"; readonly provider: string; readonly detail: string };

/**
 * The quota report as JSON, for scripts.
 *
 * The same facts the text command prints, with every reset as an absolute ISO
 * instant a script can wait on. There are no relative durations — a machine
 * reads the clock itself. `freeAt` is when the account next has room: the
 * answer for an exhausted account, null for one that is not.
 */
export const quotaJson = (
  blind: ReadonlyArray<string>,
  readings: ReadonlyArray<QuotaReading>,
  rungsOf: (provider: string) => ReadonlyArray<string>,
): string =>
  JSON.stringify(
    {
      blind,
      providers: readings.map((reading) =>
        reading._tag === "usage"
          ? {
              provider: reading.provider,
              plan: reading.usage.plan ?? null,
              exhausted: exhausted(reading.usage),
              rungs: rungsOf(reading.provider),
              freeAt: freeAt(reading.usage)?.toISOString() ?? null,
              allowances: reading.usage.allowances.map((allowance) => ({
                window: allowance.window,
                usedPercent: allowance.usedPercent,
                resetsAt: allowance.resetsAt?.toISOString() ?? null,
              })),
            }
          : { provider: reading.provider, unreadable: reading.detail },
      ),
    },
    null,
    2,
  );
