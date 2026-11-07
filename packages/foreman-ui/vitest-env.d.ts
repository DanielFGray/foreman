declare module "vitest/browser" {
  interface BrowserCommands {
    startUiServer: (origin: string) => Promise<number>;
    stopUiServer: () => Promise<void>;
  }
}

export {};
