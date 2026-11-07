/**
 * Definition of done for the pipeline editor: a drag that leaves a block
 * unreachable shows an amber preview with one problem, and a drop sends
 * exactly one PipelineEdit (docs/web-ui.md Checks; ts-755cb5).
 */
import { RegistryProvider } from "@effect/atom-react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import type { PipelineChange } from "foreman/pipeline-edit";
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

afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
});

const mountProject = (onPipelineEdit: (change: PipelineChange) => void) => {
  history.replaceState(null, "", "/p/amux");
  const host = document.createElement("div");
  host.id = "root";
  document.body.replaceChildren(host);
  root = createRoot(host);
  root.render(
    createElement(
      RegistryProvider,
      {
        initialValues: [
          [
            pageInputsAtom,
            {
              rpcUrl: `ws://127.0.0.1:${uiPort}/rpc`,
              reload: () => {},
              onPipelineEdit,
            },
          ],
        ],
      },
      createElement(App),
    ),
  );
};

describe("pipeline editor wire drag", () => {
  it("shows an amber one-problem preview for an unreachable rejoin, and drops one PipelineEdit", async () => {
    const edits: Array<PipelineChange> = [];
    mountProject((change) => {
      edits.push(change);
    });

    await expect.element(page.getByTestId("pipeline-editor")).toBeInTheDocument();
    await expect.element(page.getByTestId("exit-branch-next")).toBeInTheDocument();
    await expect.element(page.getByTestId("block-start")).toBeInTheDocument();

    await userEvent.pointer([
      { keys: "[MouseLeft>]", target: page.getByTestId("exit-branch-next") },
      { target: page.getByTestId("block-start") },
    ]);

    await expect.element(page.getByTestId("drag-preview")).toBeInTheDocument();
    const preview = page.getByTestId("drag-preview");
    await expect.element(preview).toHaveAttribute("data-tone", "amber");
    await expect.element(preview).toHaveAttribute("data-problems", "1");

    // Release via the same document listeners dragology attached; a second
    // userEvent.pointer("[/MouseLeft]") can hang once React has re-rendered the drag.
    const start = document.querySelector('[data-testid="block-start"]');
    const box = start?.getBoundingClientRect();
    const clientX = box !== undefined ? box.left + box.width / 2 : 0;
    const clientY = box !== undefined ? box.top + box.height / 2 : 0;
    document.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: 0,
        clientX,
        clientY,
      }),
    );

    await expect.poll(() => edits.length).toBe(1);
    expect(edits[0]).toEqual({
      _tag: "Rejoin",
      wire: { from: "branch", port: "next" },
      to: "start",
    });

    await expect.element(page.getByTestId("pipeline-discard")).toBeInTheDocument();
    await userEvent.click(page.getByTestId("pipeline-discard"));
    await expect
      .element(page.getByTestId("pipeline-toolbar-message"))
      .toHaveTextContent("Discarded.");
  });
});
