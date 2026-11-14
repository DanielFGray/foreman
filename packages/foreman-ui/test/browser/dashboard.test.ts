/**
 * The dashboard at `/` against the real UI server Layer and the fixture
 * reading: a working row `ts-demo` (focus, kill), a needs-you row `ts-ask`
 * (approve), and a landed row `ts-old`, all in amux (docs/web-ui.md, "The
 * dashboard"). The fixture fleet has no open space, so a row action reaches a
 * one-shot dispatcher that finds no row and refuses: the refusal is the
 * round trip a test can see without a live fleet.
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

const mountDashboard = () => {
  history.replaceState(null, "", "/");
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

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
});

describe("dashboard", () => {
  it("puts needs-you first, opens the live sections and folds history, and lists projects", async () => {
    mountDashboard();
    await expect
      .element(page.getByTestId("section-attention").getByTestId("row-attention-ts-ask"))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId("section-working").getByTestId("row-working-ts-demo"))
      .toBeInTheDocument();
    const sections = [...document.querySelectorAll("[data-testid^=section-]")].map((one) =>
      one.getAttribute("data-testid"),
    );
    expect(sections).toEqual([
      "section-attention",
      "section-working",
      "section-review",
      "section-landed",
      "section-quota",
      "section-projects",
    ]);
    expect(document.querySelector<HTMLDetailsElement>("[data-testid=section-working]")?.open).toBe(
      true,
    );
    expect(document.querySelector<HTMLDetailsElement>("[data-testid=section-landed]")?.open).toBe(
      false,
    );
    await expect.element(page.getByTestId("project-amux")).toMatchTextContent(/graph/);
    await expect.element(page.getByTestId("dispatcher-state")).toMatchTextContent("no reading yet");
  });

  it("pauses and resumes the fleet, and sets the agent limit, in the policy file", async () => {
    mountDashboard();
    await userEvent.click(page.getByTestId("fleet-pause"));
    await expect.poll(async () => (await commands.storedPolicy()).paused).toBe(true);
    await userEvent.click(page.getByTestId("fleet-resume"));
    await expect.poll(async () => (await commands.storedPolicy()).paused).toBe(false);

    await userEvent.fill(page.getByTestId("fleet-slots"), "5");
    await userEvent.click(page.getByTestId("fleet-slots-set"));
    await expect.poll(async () => (await commands.storedPolicy()).slots).toBe(5);
  });

  it("runs a key-only action on a tap and shows the dispatcher's refusal", async () => {
    mountDashboard();
    await userEvent.click(page.getByTestId("action-ts-ask-approve"));
    await expect
      .element(page.getByTestId("action-note-ts-ask"))
      .toMatchTextContent(/approve does not apply to ts-ask: no row has that key/);
  });

  it("asks kill for its reason before it sends", async () => {
    mountDashboard();
    await userEvent.click(page.getByTestId("action-ts-demo-kill"));
    await userEvent.fill(page.getByTestId("action-reason"), "wrong branch");
    await userEvent.click(page.getByTestId("action-send"));
    await expect
      .element(page.getByTestId("action-note-ts-demo"))
      .toMatchTextContent(/kill does not apply to ts-demo/);
  });
});

describe("dashboard on a phone", () => {
  it("fits the screen", async () => {
    const desktop = { width: innerWidth, height: innerHeight };
    await page.viewport(390, 844);
    try {
      mountDashboard();
      await expect.element(page.getByTestId("row-working-ts-demo")).toBeInTheDocument();
      await userEvent.click(page.getByTestId("action-ts-demo-kill"));
      await expect.element(page.getByTestId("action-reason")).toBeInTheDocument();
      const html = document.documentElement;
      expect(html.scrollWidth).toBeLessThanOrEqual(html.clientWidth);
    } finally {
      await page.viewport(desktop.width, desktop.height);
    }
  });
});
