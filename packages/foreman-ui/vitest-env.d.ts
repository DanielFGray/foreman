import type { Drawing } from "foreman/pipeline";
import type { Policy } from "foreman/policy";

declare module "vitest/browser" {
  interface BrowserCommands {
    startUiServer: (origin: string, port?: number) => Promise<number>;
    stopUiServer: () => Promise<void>;
    savedPipeline: (project: string) => Promise<Drawing | null>;
    draftPipeline: (project: string) => Promise<Drawing | null>;
    storedPolicy: () => Promise<Policy>;
    removeDraftBlock: (project: string, block: string) => Promise<void>;
  }
}

export {};
