import type { RunTable } from "./runs.ts";

type Tables = Record<"rung" | "project" | "label" | "task", ReadonlyArray<RunTable>>;

/** A file report must carry its own presentation so it remains usable without a server. */
export const report = (tables: Tables): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Foreman fleet metrics</title><style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#17202a}body{margin:2rem;max-width:110rem}h1{margin-bottom:.2rem}section{margin:2.5rem 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:.55rem;text-align:right;border-bottom:1px solid #bac3cc}th:first-child,td:first-child{text-align:left}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}@media(prefers-color-scheme:dark){:root{background:#101418;color:#e6edf3}th,td{border-color:#39434d}}small{color:#667788}</style></head><body>
<h1>Fleet metrics</h1><small>Completed spans only contribute to duration and rates. In-flight runs remain counted.</small>
${section("Rung", tables.rung)}${section("Project", tables.project)}${section("Label", tables.label)}${section("Task timeline", tables.task)}
</body></html>`;

const section = (title: string, rows: ReadonlyArray<RunTable>) =>
  `<section><h2>${title}</h2><table><thead><tr><th>Key</th><th>Runs</th><th>Median</th><th>P90</th><th>Review rejected</th><th>Escalated</th><th>Landed</th><th>Verification broke</th></tr></thead><tbody>${rows.map(row).join("")}</tbody></table></section>`;

const row = ({ key, metrics }: RunTable) =>
  `<tr><td>${escape(key)}</td><td>${metrics.runs}</td><td>${duration(metrics.medianDuration)}</td><td>${duration(metrics.p90Duration)}</td><td>${percent(metrics.reviewRejectionRate)}</td><td>${percent(metrics.escalationRate)}</td><td>${percent(metrics.landRate)}</td><td>${percent(metrics.verificationBreakRate)}</td></tr>`;

const duration = (milliseconds: number | undefined) =>
  milliseconds === undefined ? "-" : `${milliseconds.toFixed(0)} ms`;
const percent = (value: number) => `${(value * 100).toFixed(0)}%`;
const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
