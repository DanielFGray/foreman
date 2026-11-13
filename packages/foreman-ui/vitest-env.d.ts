import type { Drawing } from "foreman/pipeline";

declare module "vitest/browser" {
  interface BrowserCommands {
    startUiServer: (origin: string, port?: number) => Promise<number>;
    stopUiServer: () => Promise<void>;
    savedPipeline: (project: string) => Promise<Drawing | null>;
    draftPipeline: (project: string) => Promise<Drawing | null>;
    grantScopes: () => Promise<ReadonlyArray<string>>;
    removeDraftBlock: (project: string, block: string) => Promise<void>;
  }
}

export {};
