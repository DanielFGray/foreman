import type { NewRunInput, Role } from "tasks";
import { countOf, isResearch, SIZE, type Item } from "./records.ts";

/**
 * The store's words for foreman's accounts.
 *
 * A table rather than a convention, because the two sides use different words:
 * foreman keys an account by what reads it (`opencode-go`), the table names it
 * as an operator reads it. An unlisted provider is written as its own key,
 * which is the honest answer rather than a wrong name.
 */
const POOLS: Record<string, string> = {
  openai: "OpenAI",
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode Zen",
  claude: "Anthropic",
  anthropic: "Anthropic",
  copilot: "Copilot",
  cursor: "Cursor",
};

/** The account's name as the runs table spells it, or the account itself. */
export const poolFor = (provider: string): string => POOLS[provider] ?? provider;

/**
 * The run row foreman opens when it dispatches an agent.
 *
 * Only what foreman knows at the start: which model runs, on which account, at
 * what kind of work. `size` comes from the task's `size:<n>` label and is
 * absent where the label is. `report_accurate` stays empty: it is a judgement
 * about the author's report, and a value foreman cannot derive would put a
 * false fact in the table the operator chooses models from. The `defects` table
 * is left alone for the same reason.
 *
 * `correction` is never written: a correction is a second attempt on the same
 * slice, which the coordinator pairs by task rather than foreman seeing it as a
 * separate event.
 */
export const newRunFor = (input: {
  readonly task: Pick<Item, "id" | "title" | "project" | "labels">;
  readonly branch: string;
  readonly harness: string;
  readonly model: string | undefined;
  readonly rung: string;
  readonly provider: string | undefined;
  readonly role: Role;
  /** The pipeline block the run runs at. */
  readonly node: string;
  /** A review run records the branch tip it reads. */
  readonly commit?: string | undefined;
  /** An author on the operator's own branch records the commit it starts from. */
  readonly base?: string | undefined;
}): NewRunInput => ({
  project: input.task.project,
  task: input.task.id,
  // What the slice does, in words: the task's own title is the only sentence
  // foreman holds about it.
  slice: input.task.title,
  kind: input.harness,
  // An account foreman cannot name falls back to the harness, which is the same
  // row a rung with no model would have anyway.
  pool: input.provider === undefined ? input.harness : poolFor(input.provider),
  model: input.model ?? input.harness,
  rung: input.rung,
  node: input.node,
  work: input.role === "review" ? "review" : isResearch(input.task) ? "research" : "build",
  commit: input.commit,
  base: input.base,
  // `||`, not `??`: the table starts sizes at 1, so a `size:0` label reads as none.
  size: countOf(input.task, SIZE) || undefined,
  evidence: input.branch,
});
