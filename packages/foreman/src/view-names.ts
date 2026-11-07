/** The views the fleet has, named once so schemas can read them without loading the view rules. */
export const VIEWS = ["queue", "working", "review", "landed", "quota", "attention"] as const;
export type ViewName = (typeof VIEWS)[number];
