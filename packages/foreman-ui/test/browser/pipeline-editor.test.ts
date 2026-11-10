/**
 * Definition of done for the pipeline editor: a drag that leaves a block
 * unreachable shows an amber preview with one problem, and a drop sends
 * exactly one PipelineEdit (docs/web-ui.md Checks; ts-755cb5).
 *
 * The count is taken from the frames the page sends over its WebSocket, and the
 * result from the drafts and pipelines files the UI server writes.
 */
import { RegistryProvider } from "@effect/atom-react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { Option, Schema } from "effect";
import type { Drawing } from "foreman/pipeline";
import { PipelineEdit } from "foreman/ui-contract";
import { App } from "../../src/App.tsx";
import { pageInputsAtom } from "../../src/rpc.ts";
import "../../src/styles.css";

/**
 * A PipelineEdit request as the RPC JSON protocol encodes it. Every other
 * frame the page sends fails to decode, so it is not counted.
 */
const EditRequest = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literal("Request"),
    tag: Schema.Literal("PipelineEdit"),
    payload: Schema.toEncoded(PipelineEdit.payloadSchema),
  }),
);
const editRequestOf = Schema.decodeUnknownOption(EditRequest);

const PROJECT = "amux";

let root: Root | undefined;
let uiPort = 0;
/** The text frames the page has sent since the test began. */
let sent: Array<string> = [];

const NativeWebSocket = globalThis.WebSocket;
/** The page's socket, with every text frame it sends kept in `sent`. */
class RecordingWebSocket extends NativeWebSocket {
  override send(data: Parameters<WebSocket["send"]>[0]): void {
    if (typeof data === "string") sent.push(data);
    super.send(data);
  }
}

beforeAll(async () => {
  uiPort = await commands.startUiServer(location.origin);
});

afterAll(async () => {
  await commands.stopUiServer();
});

beforeEach(() => {
  sent = [];
  globalThis.WebSocket = RecordingWebSocket;
});

afterEach(() => {
  globalThis.WebSocket = NativeWebSocket;
  root?.unmount();
  root = undefined;
  document.body.replaceChildren();
});

const mountProject = () => {
  history.replaceState(null, "", `/p/${PROJECT}`);
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
            },
          ],
        ],
      },
      createElement(App),
    ),
  );
};

/** The PipelineEdit frames the page has sent since the test began. */
const editRequests = () => sent.flatMap((frame) => Option.toArray(editRequestOf(frame)));

/** Where `id`'s next exit leads in a drawing, or undefined. */
const nextOf = (drawing: Drawing | null, id: string): unknown => {
  const node = drawing?.nodes.find((one) => one.id === id);
  return node !== undefined && "next" in node ? node.next : undefined;
};

/** The drawn wire from `from`'s `next` exit, as the SVG path the page renders. */
const wireOf = (from: string): SVGPathElement => {
  const wire = document.getElementById(`wire-${from}-next`);
  if (!(wire instanceof SVGPathElement)) throw new Error(`no wire-${from}-next path`);
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

/** The target a named exit of a drafted node leads to. */
const exitTarget = (drawing: Drawing | null, id: string, name: string): unknown => {
  const node = drawing?.nodes.find((one) => one.id === id);
  if (node === undefined || !("exits" in node)) return undefined;
  const exits: ReadonlyArray<{ readonly name?: string; readonly to: string }> = node.exits;
  return exits.find((exit) => exit.name === name)?.to;
};

/** Holds a drag from the exit handle `handleId` over a block, and waits for the preview. */
const dragHandleOver = async (handleId: string, blockId: string) => {
  await expect.element(page.getByTestId("pipeline-editor")).toBeInTheDocument();
  await expect.element(page.getByTestId(handleId)).toBeInTheDocument();
  await expect.element(page.getByTestId(`block-${blockId}`)).toBeInTheDocument();
  await userEvent.pointer([
    { keys: "[MouseLeft>]", target: page.getByTestId(handleId) },
    { target: page.getByTestId(`block-${blockId}`) },
  ]);
  await expect.element(page.getByTestId("drag-preview")).toBeInTheDocument();
};

const dragNextExitOver = (from: string, blockId: string) =>
  dragHandleOver(`exit-${from}-next`, blockId);

describe("pipeline editor wire drag", () => {
  it("shows the server's reason and redraws its drawing when it refuses an edit", async () => {
    mountProject();
    await dragNextExitOver("branch", "start");

    // The page keeps its frame while a drag is held. The operator's draft loses
    // branch meanwhile, so the drop names a block the server no longer has.
    await commands.removeDraftBlock(PROJECT, "branch");
    releaseOver("start");

    await expect.poll(() => editRequests().length).toBe(1);
    await expect
      .poll(() => document.querySelector('[data-testid="pipeline-toolbar-message"]')?.textContent)
      .toBe("Edit not saved: branch cannot lead to start: one of them is not in the pipeline");
    // The server's drawing has no branch, so the page drops its own frame for the server's.
    await expect.poll(() => document.querySelector('[data-testid="block-branch"]')).toBeNull();
    expect(document.getElementById("wire-branch-next")).toBeNull();
    await expect.element(page.getByTestId("drag-preview")).not.toBeInTheDocument();
    expect(nextOf(await commands.draftPipeline(PROJECT), "start")).toBe("author");

    await userEvent.click(page.getByTestId("pipeline-discard"));
    await expect.poll(() => commands.draftPipeline(PROJECT)).toBeNull();
  });

  it("draws a queue exit with a handle, and rejoins it onto a block", async () => {
    mountProject();

    // author's done exit leads to review-gate; returning it to the queue is a valid rejoin.
    await dragHandleOver("exit-author-exit-done", "queue");
    releaseOver("queue");

    await expect.poll(() => editRequests().length).toBe(1);
    expect(editRequests()[0]?.payload).toEqual({
      project: PROJECT,
      change: { _tag: "Rejoin", wire: { from: "author", port: "exit:done" }, to: "queue" },
      flow: "across",
    });
    await expect
      .poll(async () => exitTarget(await commands.draftPipeline(PROJECT), "author", "done"))
      .toBe("queue");

    // The stream's drawing keeps the queue exit: its handle is on the page and its wire is drawn.
    await expect.element(page.getByTestId("exit-author-exit-done")).toBeInTheDocument();
    expect(document.getElementById("wire-author-exit-done")).not.toBeNull();

    await dragHandleOver("exit-author-exit-done", "review-gate");
    releaseOver("review-gate");

    await expect.poll(() => editRequests().length).toBe(2);
    expect(editRequests()[1]?.payload).toEqual({
      project: PROJECT,
      change: { _tag: "Rejoin", wire: { from: "author", port: "exit:done" }, to: "review-gate" },
      flow: "across",
    });
    await expect
      .poll(async () => exitTarget(await commands.draftPipeline(PROJECT), "author", "done"))
      .toBe("review-gate");
  });

  it("shows an amber one-problem preview for an unreachable rejoin, and drops one PipelineEdit", async () => {
    mountProject();

    await dragNextExitOver("branch", "start");

    const preview = page.getByTestId("drag-preview");
    await expect.element(preview).toHaveAttribute("data-tone", "amber");
    await expect.element(preview).toHaveAttribute("data-problems", "1");
    // The tone is an SVG attribute; a CSS rule on .wire would override it.
    await expect.poll(() => getComputedStyle(wireOf("branch")).stroke).toBe("rgb(154, 103, 0)");
    expect(getComputedStyle(wireOf("branch")).strokeWidth).toBe("3px");

    releaseOver("start");

    await expect.poll(() => editRequests().length).toBe(1);
    expect(editRequests()[0]?.payload).toEqual({
      project: PROJECT,
      change: { _tag: "Rejoin", wire: { from: "branch", port: "next" }, to: "start" },
      flow: "across",
    });
    // The server wrote the change to the draft, and the page keeps the dropped drawing.
    await expect
      .poll(async () => nextOf(await commands.draftPipeline(PROJECT), "branch"))
      .toBe("start");
    expect(editRequests()).toHaveLength(1);

    await expect.element(page.getByTestId("pipeline-discard")).toBeInTheDocument();
    await userEvent.click(page.getByTestId("pipeline-discard"));
    await expect
      .element(page.getByTestId("pipeline-toolbar-message"))
      .toHaveTextContent("Discarded.");
    await expect.poll(() => commands.draftPipeline(PROJECT)).toBeNull();
  });

  it("shows a green preview when the candidate passes the check, and drops nothing for the unchanged target", async () => {
    mountProject();

    // branch.next already leads to retry, the one target the default pipeline can take.
    await dragNextExitOver("branch", "retry");

    const preview = page.getByTestId("drag-preview");
    await expect.element(preview).toHaveAttribute("data-tone", "green");
    await expect.element(preview).toHaveAttribute("data-problems", "0");
    await expect.poll(() => getComputedStyle(wireOf("branch")).stroke).toBe("rgb(26, 127, 55)");
    expect(getComputedStyle(wireOf("branch")).strokeWidth).toBe("3px");

    releaseOver("retry");

    await expect.element(page.getByTestId("drag-preview")).not.toBeInTheDocument();
    expect(editRequests()).toEqual([]);
  });

  it("sends one PipelineEdit for a valid rejoin, and Save writes it to the pipelines file", async () => {
    mountProject();

    // start.next leads to author; climb is also a valid target, so this drop passes the check.
    await dragNextExitOver("start", "climb");
    await expect.element(page.getByTestId("drag-preview")).toHaveAttribute("data-tone", "green");

    releaseOver("climb");

    await expect.poll(() => editRequests().length).toBe(1);
    expect(editRequests()[0]?.payload).toEqual({
      project: PROJECT,
      change: { _tag: "Rejoin", wire: { from: "start", port: "next" }, to: "climb" },
      flow: "across",
    });
    await expect
      .poll(async () => nextOf(await commands.draftPipeline(PROJECT), "start"))
      .toBe("climb");

    await expect.element(page.getByTestId("pipeline-save")).toBeEnabled();
    await userEvent.click(page.getByTestId("pipeline-save"));
    await expect.element(page.getByTestId("pipeline-toolbar-message")).toHaveTextContent("Saved.");
    await expect
      .poll(async () => nextOf(await commands.savedPipeline(PROJECT), "start"))
      .toBe("climb");
    await expect.poll(() => commands.draftPipeline(PROJECT)).toBeNull();
    expect(editRequests()).toHaveLength(1);
  });
});
