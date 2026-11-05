/**
 * The task store's timestamps, as its two writers leave them.
 *
 * Item and label times are Go's `time.Time` string in local time:
 * `2026-11-01 17:07:52.490666699 -0600 CST`, sometimes followed by a monotonic
 * clock reading (` m=+0.005043018`) that means nothing outside the process that
 * wrote it. Log times, and a few item times, are SQLite's `CURRENT_TIMESTAMP`:
 * `2026-11-01 22:39:22`, in UTC. Readers compare these columns as text, so a
 * writer keeps each column in the layout already there.
 */
import { Option } from "effect";

const GO = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ([+-])(\d{2})(\d{2}) \S+/;
const SQLITE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?Z?$/;

/** Reads a stored time in either layout, or nothing when it is neither. */
export const parseStored = (text: string): Option.Option<Date> => {
  const go = GO.exec(text);
  if (go !== null) {
    const [, day, clock, fraction = "", sign, hours, minutes] = go;
    return Option.some(
      new Date(`${day}T${clock}${fraction.slice(0, 4)}${sign}${hours}:${minutes}`),
    );
  }
  const sqlite = SQLITE.exec(text);
  if (sqlite !== null) {
    const [, day, clock, fraction = ""] = sqlite;
    return Option.some(new Date(`${day}T${clock}${fraction.slice(0, 4)}Z`));
  }
  return Option.none();
};

/**
 * `date` in Go's layout, in this machine's zone, without the monotonic part.
 * Go's `time.String` trims trailing zeros from the fraction, and so does this.
 */
export const formatGo = (date: Date): string => {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const fraction =
    date.getMilliseconds() === 0 ? "" : `.${pad(date.getMilliseconds(), 3)}`.replace(/0+$/, "");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? "UTC";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${fraction} ` +
    `${sign}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)} ${zone}`
  );
};
