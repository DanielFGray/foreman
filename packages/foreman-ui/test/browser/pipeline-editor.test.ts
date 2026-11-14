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
  Schema.TaggedStruct("Request", {
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

/** While true, the page's sockets keep what the server sends instead of delivering it. */
let holding = false;
/** The sockets the page opened, so a test can deliver what they held. */
let sockets: Array<RecordingWebSocket> = [];

const NativeWebSocket = globalThis.WebSocket;
/**
 * The page's socket, with every text frame it sends kept in `sent`. While
 * `holding`, a message from the server stops at the first listener, which this
 * constructor registers ahead of the page's, and `deliver` sends it on later.
 */
class RecordingWebSocket extends NativeWebSocket {
  private held: Array<MessageEvent> = [];

  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    sockets.push(this);
    this.addEventListener("message", (event) => {
      if (!holding) return;
      event.stopImmediatePropagation();
      this.held.push(new MessageEvent("message", { data: event.data }));
    });
  }

  override send(data: Parameters<WebSocket["send"]>[0]): void {
    if (typeof data === "string") sent.push(data);
    super.send(data);
  }

  /** Sends on every held message, in the order it arrived. */
  deliver(): void {
    const held = this.held;
    this.held = [];
    held.forEach((event) => this.dispatchEvent(event));
  }
}

/** Stops the server's messages reaching the page, as a slow answer would. */
const hold = () => {
  holding = true;
};

/** Lets the server's messages through again, the held ones first. */
const release = () => {
  holding = false;
  sockets.forEach((socket) => socket.deliver());
};

beforeAll(async () => {
  uiPort = await commands.startUiServer(location.origin);
});

afterAll(async () => {
  await commands.stopUiServer();
});

beforeEach(() => {
  sent = [];
  sockets = [];
  holding = false;
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

/** Where `id`'s next exit leads in a drawing. */
const nextOf = (drawing: Drawing | null, id: string): Option.Option<string> =>
  Option.fromNullishOr(drawing?.nodes.find((one) => one.id === id)).pipe(
    Option.flatMap((node) => ("next" in node ? Option.some(node.next) : Option.none())),
  );

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
const releaseOver = (blockId: string, pointerType: "mouse" | "touch" = "mouse") => {
  const box = document.querySelector(`[data-testid="block-${blockId}"]`)?.getBoundingClientRect();
  const clientX = box !== undefined ? box.left + box.width / 2 : 0;
  const clientY = box !== undefined ? box.top + box.height / 2 : 0;
  document.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType,
      button: 0,
      buttons: 0,
      clientX,
      clientY,
    }),
  );
};

/** The target a named exit of a drafted node leads to. */
const exitTarget = (drawing: Drawing | null, id: string, name: string): Option.Option<string> =>
  Option.fromNullishOr(drawing?.nodes.find((one) => one.id === id)).pipe(
    Option.flatMap((node) => {
      if (!("exits" in node)) return Option.none();
      const exits: ReadonlyArray<{ readonly name?: string; readonly to: string }> = node.exits;
      return Option.fromNullishOr(exits.find((exit) => exit.name === name)?.to);
    }),
  );

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

/** The centre of the element with test id `id`, in client coordinates. */
const centreOf = (id: string) => {
  const box = document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
  if (box === undefined) throw new Error(`no ${id}`);
  return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
};

/**
 * Presses a finger on `handleId` and moves it over `blockId`, as a phone's
 * pointer events do once touch-action lets the drag through.
 */
const touchDragOver = async (handleId: string, blockId: string) => {
  const touch = { bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch" };
  const handle = document.querySelector(`[data-testid="${handleId}"]`);
  if (handle === null) throw new Error(`no ${handleId}`);
  const from = centreOf(handleId);
  const to = centreOf(`block-${blockId}`);
  handle.dispatchEvent(
    new PointerEvent("pointerdown", { ...touch, isPrimary: true, button: 0, buttons: 1, ...from }),
  );
  for (const step of [0.25, 0.5, 0.75, 1]) {
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        ...touch,
        isPrimary: true,
        buttons: 1,
        clientX: from.clientX + (to.clientX - from.clientX) * step,
        clientY: from.clientY + (to.clientY - from.clientY) * step,
      }),
    );
  }
  await expect.element(page.getByTestId("drag-preview")).toBeInTheDocument();
};

describe("pipeline editor on a phone", () => {
  it("fits the screen, lays out down, and sends one PipelineEdit for a touch drag", async () => {
    const desktop = { width: innerWidth, height: innerHeight };
    await page.viewport(390, 844);
    try {
      mountProject();
      await expect.element(page.getByTestId("exit-start-next")).toBeInTheDocument();
      await expect.element(page.getByTestId("block-climb")).toBeInTheDocument();

      const html = document.documentElement;
      expect(html.scrollWidth).toBeLessThanOrEqual(html.clientWidth);
      // A finger on the drawing scrolls; a finger on an exit handle drags.
      const svg = document.querySelector('[data-testid="pipeline-canvas"] svg');
      if (svg === null) throw new Error("no pipeline svg");
      expect(getComputedStyle(svg).touchAction).toBe("pan-x pan-y");
      const handle = document.querySelector('[data-testid="exit-start-next"]');
      if (handle === null) throw new Error("no exit-start-next");
      expect(getComputedStyle(handle).touchAction).toBe("none");

      await touchDragOver("exit-start-next", "climb");
      releaseOver("climb", "touch");

      await expect.poll(() => editRequests().length).toBe(1);
      expect(editRequests()[0]?.payload).toEqual({
        project: PROJECT,
        change: { _tag: "Rejoin", wire: { from: "start", port: "next" }, to: "climb" },
        flow: "down",
      });
      await expect
        .poll(async () => nextOf(await commands.draftPipeline(PROJECT), "start"))
        .toEqual(Option.some("climb"));

      await userEvent.click(page.getByTestId("pipeline-discard"));
      await expect.poll(() => commands.draftPipeline(PROJECT)).toBeNull();
    } finally {
      await page.viewport(desktop.width, desktop.height);
    }
  });
});

describe("pipeline editor wire drag", () => {
  it("previews a second drag while the first drop waits for the server's answer", async () => {
    mountProject();
    await dragNextExitOver("start", "climb");
    hold();
    releaseOver("climb");

    await expect.poll(() => editRequests().length).toBe(1);
    await expect
      .poll(async () => nextOf(await commands.draftPipeline(PROJECT), "start"))
      .toEqual(Option.some("climb"));

    // The answer to the first edit has not reached the page, and a drag still previews.
    await dragNextExitOver("branch", "start");
    await expect.element(page.getByTestId("drag-preview")).toHaveAttribute("data-tone", "amber");
    releaseOver("start");
    // The page sends its next edit only after the server answers the first.
    expect(editRequests()).toHaveLength(1);

    release();
    await expect.poll(() => editRequests().length).toBe(2);
    await expect
      .poll(async () => nextOf(await commands.draftPipeline(PROJECT), "branch"))
      .toEqual(Option.some("start"));
    expect(nextOf(await commands.draftPipeline(PROJECT), "start")).toEqual(Option.some("climb"));

    await userEvent.click(page.getByTestId("pipeline-discard"));
    await expect.poll(() => commands.draftPipeline(PROJECT)).toBeNull();
  });

  it("draws the server's draft when it differs from the drawing the page dropped", async () => {
    mountProject();
    await expect.element(page.getByTestId("block-branch")).toBeInTheDocument();
    // Another writer removes branch, and the page has not heard yet, so it drops
    // onto a drawing that still has branch. No drawing the server sends equals it.
    hold();
    await commands.removeDraftBlock(PROJECT, "branch");
    await dragNextExitOver("start", "climb");
    releaseOver("climb");
    await expect
      .poll(async () => nextOf(await commands.draftPipeline(PROJECT), "start"))
      .toEqual(Option.some("climb"));
    expect(document.querySelector('[data-testid="block-branch"]')).not.toBeNull();
    release();

    await expect.poll(() => document.querySelector('[data-testid="block-branch"]')).toBeNull();
    await expect.element(page.getByTestId("exit-start-next")).toBeInTheDocument();
    expect(document.getElementById("wire-branch-next")).toBeNull();

    await userEvent.click(page.getByTestId("pipeline-discard"));
    await expect.poll(() => commands.draftPipeline(PROJECT)).toBeNull();
  });

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
    expect(nextOf(await commands.draftPipeline(PROJECT), "start")).toEqual(Option.some("author"));

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
      .toEqual(Option.some("queue"));

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
      .toEqual(Option.some("review-gate"));
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
    // The server wrote the change to the draft.
    await expect
      .poll(async () => nextOf(await commands.draftPipeline(PROJECT), "branch"))
      .toEqual(Option.some("start"));
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

    // branch.next already leads to retry, the one target the checkout pipeline can take.
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
      .toEqual(Option.some("climb"));

    await expect.element(page.getByTestId("pipeline-save")).toBeEnabled();
    await userEvent.click(page.getByTestId("pipeline-save"));
    await expect.element(page.getByTestId("pipeline-toolbar-message")).toHaveTextContent("Saved.");
    await expect
      .poll(async () => nextOf(await commands.savedPipeline(PROJECT), "start"))
      .toEqual(Option.some("climb"));
    await expect.poll(() => commands.draftPipeline(PROJECT)).toBeNull();
    expect(editRequests()).toHaveLength(1);
  });
});
