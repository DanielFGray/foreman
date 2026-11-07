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

/** The drawn wire from branch's next exit, as the SVG path the page renders. */
const branchNextWire = (): SVGPathElement => {
  const wire = document.getElementById("wire-branch-next");
  if (!(wire instanceof SVGPathElement)) throw new Error("no wire-branch-next path");
  return wire;
};

/**
 * Ends the drag where dragology is listening. A second userEvent.pointer release
 * can hang once React has re-rendered the drag, so the release is dispatched on
 * the document, at the centre of the target block.
 */
const releaseOver = (blockId: string) => {
  const box = document.querySelector(`[data-testid="block-${blockId}"]`)?.getBoundingClientRect();
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
};

/** Holds a drag from branch's next exit over the block, and waits for the preview. */
const dragBranchNextOver = async (blockId: string) => {
  await expect.element(page.getByTestId("pipeline-editor")).toBeInTheDocument();
  await expect.element(page.getByTestId("exit-branch-next")).toBeInTheDocument();
  await expect.element(page.getByTestId(`block-${blockId}`)).toBeInTheDocument();
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: page.getByTestId("exit-branch-next") },
    { target: page.getByTestId(`block-${blockId}`) },
  ]);
  await expect.element(page.getByTestId("drag-preview")).toBeInTheDocument();
};

describe("pipeline editor wire drag", () => {
  it("shows an amber one-problem preview for an unreachable rejoin, and drops one PipelineEdit", async () => {
    const edits: Array<PipelineChange> = [];
    mountProject((change) => {
      edits.push(change);
    });

    await dragBranchNextOver("start");

    const preview = page.getByTestId("drag-preview");
    await expect.element(preview).toHaveAttribute("data-tone", "amber");
    await expect.element(preview).toHaveAttribute("data-problems", "1");
    // The tone is an SVG attribute; a CSS rule on .wire would override it.
    await expect.poll(() => getComputedStyle(branchNextWire()).stroke).toBe("rgb(154, 103, 0)");
    expect(getComputedStyle(branchNextWire()).strokeWidth).toBe("3px");

    releaseOver("start");

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

  it("shows a green preview when the candidate passes the check, and drops nothing for the unchanged target", async () => {
    const edits: Array<PipelineChange> = [];
    mountProject((change) => {
      edits.push(change);
    });

    // branch.next already leads to retry, the one target the default pipeline can take.
    await dragBranchNextOver("retry");

    const preview = page.getByTestId("drag-preview");
    await expect.element(preview).toHaveAttribute("data-tone", "green");
    await expect.element(preview).toHaveAttribute("data-problems", "0");
    await expect.poll(() => getComputedStyle(branchNextWire()).stroke).toBe("rgb(26, 127, 55)");
    expect(getComputedStyle(branchNextWire()).strokeWidth).toBe("3px");

    releaseOver("retry");

    await expect.element(page.getByTestId("drag-preview")).not.toBeInTheDocument();
    expect(edits).toEqual([]);
  });
});
