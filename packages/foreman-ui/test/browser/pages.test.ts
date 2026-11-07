/**
 * Browser Mode checks against the real UI server Layer: project list, project
 * readings, and the disconnected banner. Vitest serves the React page; the UI
 * server Layer provides the contract over WebSocket (docs/web-ui.md, Tests).
 * A missing Chromium fails this gate.
 */
import { RegistryProvider } from "@effect/atom-react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { App } from "../../src/App.tsx";
import { installSocketTracking } from "../../src/sockets.ts";
import "../../src/styles.css";

let root: Root | undefined;

beforeAll(async () => {
  window.__FOREMAN_UI_PORT__ = await commands.startUiServer(location.origin);
});

afterAll(async () => {
  await commands.stopUiServer();
});

const mountPage = (pathname: string) => {
  installSocketTracking();
  history.replaceState(null, "", pathname);
  const host = document.createElement("div");
  host.id = "root";
  document.body.replaceChildren(host);
  root = createRoot(host);
  root.render(createElement(RegistryProvider, null, createElement(App)));
};

afterEach(() => {
  root?.unmount();
  root = undefined;
  delete window.__FOREMAN_RELOAD__;
  document.body.replaceChildren();
});

beforeEach(() => {
  delete window.__FOREMAN_RELOAD__;
});

describe("foreman-ui pages", () => {
  it("lists projects at /", async () => {
    mountPage("/");
    await expect.element(page.getByTestId("project-list")).toBeInTheDocument();
    await expect.element(page.getByTestId("project-amux")).toBeInTheDocument();
    await expect.element(page.getByTestId("project-foreman")).toBeInTheDocument();
  });

  it("shows a project's readings at /p/<project>", async () => {
    mountPage("/p/amux");
    await expect.element(page.getByTestId("project-page-amux")).toBeInTheDocument();
    await expect.element(page.getByTestId("project-meta")).toBeInTheDocument();
    await expect.element(page.getByTestId("project-rows")).toBeInTheDocument();
    await expect.element(page.getByText(/Wire the page/)).toBeInTheDocument();
    await expect
      .element(page.getByTestId("project-meta").getByText(/directory: \/tmp\/amux/))
      .toBeInTheDocument();
  });

  it("shows disconnected when the socket drops, then reloads on reconnect", async () => {
    let reloads = 0;
    window.__FOREMAN_RELOAD__ = () => {
      reloads += 1;
    };

    mountPage("/");
    await expect.element(page.getByTestId("project-list")).toBeInTheDocument();

    const sockets = window.__FOREMAN_SOCKETS__;
    if (sockets === undefined) throw new Error("no socket set");
    for (const socket of sockets) socket.close();

    await expect.element(page.getByTestId("disconnected")).toBeInTheDocument();

    await expect.poll(() => reloads, { timeout: 5_000 }).toBeGreaterThanOrEqual(1);
  });
});
