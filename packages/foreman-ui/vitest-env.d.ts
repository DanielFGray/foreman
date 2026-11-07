declare module "vitest/browser" {
  interface BrowserCommands {
    startUiServer: (origin: string, port?: number) => Promise<number>;
    stopUiServer: () => Promise<void>;
  }
}

export {};
