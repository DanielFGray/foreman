/** The board columns a task shows in. Pure, so the published Schemas can read them. */
export const BOARD_COLUMNS = [
  "queue",
  "needs-you",
  "authoring",
  "review",
  "fixing",
  "landed",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
