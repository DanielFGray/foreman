/**
 * Tracks live WebSockets so a browser test can close them and prove the
 * disconnect banner. The production page installs this once at startup.
 */

declare global {
  interface Window {
    /** Live WebSockets the page opened; browser tests close them to prove disconnect. */
    __FOREMAN_SOCKETS__?: Set<WebSocket>;
    /** Last WebSocket URL opened, for browser-test diagnostics. */
    __FOREMAN_LAST_WS__?: string;
    /**
     * Optional reload hook for browser tests. Production leaves this unset and
     * uses `location.reload` so a reconnect picks up the new serve's code.
     */
    __FOREMAN_RELOAD__?: () => void;
  }
}

/** Patches `WebSocket` once and exposes the live set on `window`. */
export const installSocketTracking = (): Set<WebSocket> => {
  const existing = globalThis.window.__FOREMAN_SOCKETS__;
  if (existing !== undefined) return existing;

  const sockets = new Set<WebSocket>();
  globalThis.window.__FOREMAN_SOCKETS__ = sockets;
  const OriginalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class ForemanWebSocket extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | Array<string>) {
      super(url, protocols);
      globalThis.window.__FOREMAN_LAST_WS__ = String(url);
      sockets.add(this);
      this.addEventListener("close", () => {
        sockets.delete(this);
      });
    }
  } as typeof WebSocket;
  return sockets;
};

/** Reload the page, or the test hook when one is installed. */
export const reloadPage = (): void => {
  const hook = globalThis.window.__FOREMAN_RELOAD__;
  if (typeof hook === "function") {
    hook();
    return;
  }
  globalThis.location.reload();
};
