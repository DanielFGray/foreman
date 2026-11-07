declare module "vitest" {
  export interface ProvidedContext {
    uiPort: number;
    uiUrl: string;
  }
}

export {};
