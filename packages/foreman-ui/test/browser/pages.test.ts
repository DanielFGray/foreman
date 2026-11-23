/**
 * Browser Mode checks against the real UI server Layer: project list, project
 * readings, and the disconnected banner. Vitest serves the React page; the UI
 * server Layer provides the contract over WebSocket (docs/web-ui.md, Tests).
 * A missing Chromium fails this gate.
 */
import { RegistryProvider } from "@effect/atom-react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { App } from "../../src/App.tsx";
import { pageInputsAtom } from "../../src/rpc.ts";
import "../../src/styles.css";

let root: Root | undefined;
let uiPort = 0;

beforeAll(async () => {
  uiPort = await commands.startUiServer(location.origin);
});

afterAll(async () => {
  await commands.stopUiServer();
});

/** Mounts the page at `pathname`, connected to the fixture UI server. */
const mountPage = (pathname: string, reload: () => void = () => {}) => {
  history.replaceState(null, "", pathname);
  const host = document.createElement("div");
  host.id = "root";
  document.body.replaceChildren(host);
  root = createRoot(host);
  const inputs = { rpcUrl: `ws://127.0.0.1:${uiPort}/rpc`, reload };
  root.render(
    createElement(
      RegistryProvider,
      { initialValues: [[pageInputsAtom, inputs]] },
      createElement(App),
    ),
  );
};

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
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

  it("charts the closed runs at /metrics, and narrows them to the runs launched by hand", async () => {
    // The fixture store holds 160 closed agent runs; every fifth has no rung.
    mountPage("/metrics?window=all");
    const totals = page.getByTestId("metrics-totals");
    await expect.element(totals.getByText("160", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByTestId("card-endings").getByText("cheap")).toBeInTheDocument();

    await page.getByTestId("launcher-hand").click();
    await expect.element(totals.getByText("32", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByTestId("card-endings").getByText(/a run launched by hand has neither/))
      .toBeInTheDocument();

    await page.getByTestId("view-models-table").click();
    await expect
      .element(page.getByTestId("card-models").getByRole("columnheader", { name: "Share" }))
      .toBeInTheDocument();
  });

  it("shows disconnected while the server is down, then reloads once it is back", async () => {
    let reloads = 0;
    mountPage("/", () => {
      reloads += 1;
    });
    await expect.element(page.getByTestId("project-list")).toBeInTheDocument();

    await commands.stopUiServer();
    await expect.element(page.getByTestId("disconnected")).toBeInTheDocument();

    // Several one-second retries fail while the server is down: the banner
    // stays and no reload happens.
    await new Promise((ready) => setTimeout(ready, 2_500));
    await expect.element(page.getByTestId("disconnected")).toBeInTheDocument();
    expect(reloads).toBe(0);

    await commands.startUiServer(location.origin, uiPort);
    // A retry runs each second, so one reload is due within two seconds of the restart.
    await expect.poll(() => reloads, { timeout: 2_000 }).toBeGreaterThanOrEqual(1);
  });
});
