/**
 * The task graph on `/p/<project>/graph` against the real UI server Layer and
 * the fixture store's amux graph: an epic `ep-graph` over `ts-g1` and `ts-g2`
 * (ts-g2 waits for ts-g1), `ts-g3` waiting for ts-g2, and `ts-g4`, done
 * (docs/web-ui.md, "The task graph").
 */
import { RegistryProvider } from "@effect/atom-react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
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

/** Mounts the page at `path`, connected to the fixture UI server. */
const mount = (path: string) => {
  history.replaceState(null, "", path);
  const host = document.createElement("div");
  host.id = "root";
  document.body.replaceChildren(host);
  root = createRoot(host);
  const inputs = { rpcUrl: `ws://127.0.0.1:${uiPort}/rpc`, reload: () => {} };
  root.render(
    createElement(
      RegistryProvider,
      { initialValues: [[pageInputsAtom, inputs]] },
      createElement(App),
    ),
  );
};

const mountGraph = (search = "") => mount(`/p/amux/graph${search}`);

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
});

const card = (id: string) => page.getByTestId(`graph-card-${id}`);

describe("task graph", () => {
  it("is linked from the project page", async () => {
    mount("/p/amux");
    await expect.element(page.getByTestId("graph-link")).toHaveAttribute("href", "/p/amux/graph");
  });

  it("draws open work, folds an epic into one card, and keeps the fold in the URL", async () => {
    mountGraph();
    for (const id of ["ep-graph", "ts-g1", "ts-g2", "ts-g3"]) {
      await expect.element(card(id)).toBeInTheDocument();
    }
    await expect.element(card("ts-g4")).not.toBeInTheDocument();

    await userEvent.click(page.getByTestId("graph-fold-ep-graph"));
    await expect.element(card("ts-g1")).not.toBeInTheDocument();
    await expect.element(card("ts-g2")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("graph-fold-ep-graph")).toHaveTextContent("▸ 2");
    expect(new URLSearchParams(location.search).get("fold")).toBe("ep-graph");
    // The fold toggle does not pick the epic.
    expect(new URLSearchParams(location.search).get("pick")).toBeNull();
  });

  it("shows a done item when its status is ticked, and a search keeps a match's epic as context", async () => {
    mountGraph("?q=fold");
    await expect.element(card("ts-g2")).toBeInTheDocument();
    await expect.element(card("ep-graph")).toHaveClass(/context/);
    await expect.element(card("ts-g1")).not.toBeInTheDocument();

    await userEvent.clear(page.getByTestId("graph-search"));
    await userEvent.click(page.getByTestId("graph-status-done"));
    await expect.element(card("ts-g4")).toBeInTheDocument();
    expect(new URLSearchParams(location.search).get("status")).toBe("open,in_progress,done");
  });

  it("sends a picked card through with one grant, marks it, and revokes it from the detail panel", async () => {
    mountGraph();
    await userEvent.click(card("ts-g3"));
    await expect.element(page.getByTestId("graph-detail")).toMatchTextContent("ts-g3");
    await userEvent.click(page.getByTestId("graph-send"));

    await expect
      .poll(() =>
        commands.storedPolicy().then((policy) => policy.grants.map((grant) => grant.scope)),
      )
      .toEqual(["ts-g3"]);
    await expect.element(card("ts-g3")).toHaveClass(/granted/);

    await userEvent.click(card("ts-g3"));
    await expect.element(page.getByTestId("graph-detail-grant")).not.toHaveTextContent("none");
    await userEvent.click(page.getByTestId("graph-revoke"));
    await expect
      .poll(() =>
        commands.storedPolicy().then((policy) => policy.grants.map((grant) => grant.scope)),
      )
      .toEqual([]);
    await expect.element(page.getByTestId("graph-detail-grant")).toHaveTextContent("none");
  });
});

describe("navigation", () => {
  it("moves between pages inside the one page load, and Back returns", async () => {
    mount("/");
    const load = performance.timeOrigin;
    await userEvent.click(page.getByTestId("project-amux").getByText("graph"));
    await expect.element(page.getByTestId("graph-page-amux")).toBeInTheDocument();
    expect(location.pathname).toBe("/p/amux/graph");

    await userEvent.type(page.getByTestId("graph-search"), "g3");
    await expect.element(page.getByTestId("graph-search")).toHaveValue("g3");
    expect(new URLSearchParams(location.search).get("q")).toBe("g3");

    history.back();
    await expect.element(page.getByTestId("dashboard")).toBeInTheDocument();
    expect(performance.timeOrigin).toBe(load);
  });
});

describe("task graph on a phone", () => {
  it("fits the screen and lays out down", async () => {
    const desktop = { width: innerWidth, height: innerHeight };
    await page.viewport(390, 844);
    try {
      mountGraph("?pick=ts-g2");
      await expect.element(card("ts-g3")).toBeInTheDocument();
      await expect.element(page.getByTestId("graph-detail")).toBeInTheDocument();
      const html = document.documentElement;
      expect(html.scrollWidth).toBeLessThanOrEqual(html.clientWidth);
      const top = (id: string) =>
        document.querySelector(`[data-testid="graph-card-${id}"]`)?.getBoundingClientRect().top ??
        Number.NaN;
      // Down: a waiting item sits below the one it waits for.
      expect(top("ts-g2")).toBeGreaterThan(top("ts-g1"));
      expect(top("ts-g3")).toBeGreaterThan(top("ts-g2"));
    } finally {
      await page.viewport(desktop.width, desktop.height);
    }
  });
});
