import { describe, expect, mock, test } from "bun:test";
import { Navigation } from "./navigation.js";
import { setTimeout as sleep } from "node:timers/promises";

// The pane's own methods (follow, loadDrawing, openDefinition, closeDefinition,
// ask) run on a Foreman instance whose host modules are stubbed and whose
// `foreman` command is a queue of reads the test answers by hand.
mock.module("herdr", () => ({
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  readTextFile: async () => "",
  watchFolder: async () => [],
  theme: () => ({}),
  props: () => ({}),
  home: () => "/home",
  spaces: () => [],
  notify: () => {},
  settings: () => ({}),
}));
const chainable = new Proxy(function () {}, {
  get: () => chainable,
  apply: () => chainable,
});
mock.module("gpui-kit", () => ({ View: class {}, div: chainable, PathBuilder: class {} }));
mock.module("gpui-base", () => ({
  v_flex: chainable,
  h_flex: chainable,
  InputState: class {},
  Input: chainable,
  EditorState: class {},
  SliderState: class {},
  Slider: chainable,
  SliderTrack: chainable,
  SliderIndicator: chainable,
  SliderThumb: chainable,
  Editor: class {},
}));
const { default: Foreman } = await import("./main.js");

const reading = (name) => ({
  name,
  drawing: { blocks: [{ id: `${name}.a` }] },
  pipeline: { nodes: [] },
  choices: { unsaved: [], composites: ["loop"] },
  draft: null,
});

// A pane in `project` with a pipeline reading shown; `pending` holds the reads
// not yet answered, each { args, ok(shown), fail(text) }.
const pane = async (project = "alpha") => {
  const p = Object.create(Foreman.prototype);
  const pending = [];
  Object.assign(p, {
    nav: new Navigation(),
    mode: "pipeline",
    tasksMode: "queue",
    models: { load() {} },
    selected: null,
    selection: new Set(),
    problem: null,
    busy: false,
    fitted: false,
    size: null,
    editor: { on: false, follow() {}, load() {}, toggle() {} },
    sim: { on: false, toggle() {} },
    fleet: { on: false, toggle() {} },
    tasks: { clear() {} },
    detail: { clear() {} },
    loadQueue() {},
    project: () => project,
    foreman: (args) =>
      new Promise((resolve) =>
        pending.push({
          args,
          ok: (shown) => resolve({ code: 0, stdout: JSON.stringify(shown), stderr: "" }),
          fail: (text) => resolve({ code: 1, stdout: "", stderr: text }),
        }),
      ),
  });
  const cx = { spawn: (f) => f(cx), notify() {}, timer: {} };
  const flush = () => sleep(0);
  p.follow(cx);
  (await next(pending, flush)).ok(reading("pipeline-alpha"));
  await flush();
  return { p, cx, pending, flush };
};
const next = async (pending, flush) => {
  await flush();
  return pending.shift();
};

describe("pane navigation", () => {
  test("opening a definition keeps the drawing until the definition reads", async () => {
    const { p, cx, pending, flush } = await pane();
    p.openDefinition("loop", cx);
    expect(p.view().name).toBe("pipeline-alpha");
    const read = await next(pending, flush);
    expect(read.args.slice(0, 3)).toEqual(["composite", "show", "loop"]);
    read.ok(reading("loop"));
    await flush();
    expect(p.definition).toBe("loop");
    expect(p.view().name).toBe("loop");
  });

  test("back succeeds: the pipeline reading replaces the definition in one step", async () => {
    const { p, cx, pending, flush } = await pane();
    p.openDefinition("loop", cx);
    (await next(pending, flush)).ok(reading("loop"));
    await flush();
    p.closeDefinition(cx);
    expect(p.view().name).toBe("loop");
    expect(p.view().drawing).toBeDefined();
    (await next(pending, flush)).ok(reading("pipeline-alpha"));
    await flush();
    expect(p.definition).toBeNull();
    expect(p.view().name).toBe("pipeline-alpha");
  });

  test("back fails: the definition stays on screen with the refusal, and commands address it", async () => {
    const { p, cx, pending, flush } = await pane();
    p.openDefinition("loop", cx);
    (await next(pending, flush)).ok(reading("loop"));
    await flush();
    p.closeDefinition(cx);
    (await next(pending, flush)).fail("boom");
    await flush();
    expect(p.view().drawing).toBeDefined();
    expect(p.view().name).toBe("loop");
    expect(p.definition).toBe("loop");
    expect(p.problem).toContain("boom");
    p.change({ op: "x" }, cx);
    expect((await next(pending, flush)).args.slice(0, 3)).toEqual(["composite", "edit", "loop"]);
  });

  test("a failed open keeps the pipeline reading and target", async () => {
    const { p, cx, pending, flush } = await pane();
    p.openDefinition("loop", cx);
    (await next(pending, flush)).fail("no such composite");
    await flush();
    expect(p.view().name).toBe("pipeline-alpha");
    expect(p.definition).toBeNull();
    expect(p.nav.target).toEqual({ project: "alpha" });
  });

  test("a project switch resets the definition and selection, and reads that project's pipeline", async () => {
    const { p, cx, pending, flush } = await pane();
    p.openDefinition("loop", cx);
    (await next(pending, flush)).ok(reading("loop"));
    await flush();
    p.selection = new Set(["loop.a"]);
    p.project = () => "beta";
    p.follow(cx);
    expect(p.selection.size).toBe(0);
    expect(p.shown).toBeNull();
    const read = await next(pending, flush);
    expect(read.args.slice(0, 3)).toEqual(["pipeline", "show", "beta"]);
  });

  test("an overlapping read: the answer to the old target is not labelled as the new one", async () => {
    const { p, cx, pending, flush } = await pane();
    p.loadDrawing(cx);
    const old = await next(pending, flush);
    p.openDefinition("loop", cx);
    old.ok(reading("pipeline-alpha-late"));
    await flush();
    expect(p.definition).toBeNull();
    expect(p.view().name).toBe("pipeline-alpha");
    const read = await next(pending, flush);
    expect(read.args.slice(0, 3)).toEqual(["composite", "show", "loop"]);
    read.ok(reading("loop"));
    await flush();
    expect(p.definition).toBe("loop");
  });

  test("an overlapping read that fails does not revert the newer target", async () => {
    const { p, cx, pending, flush } = await pane();
    p.loadDrawing(cx);
    const old = await next(pending, flush);
    p.openDefinition("loop", cx);
    old.fail("late failure");
    await flush();
    expect(p.nav.target.definition).toBe("loop");
    expect((await next(pending, flush)).args[2]).toBe("loop");
  });
});


const { Editor } = await import("./editor.js");

describe("editor prompt preview", () => {
  const agent = { id: "review", kind: "agent", instructions: "review" };
  // An editor with the pane's real foreman command queue; it reads the prompt
  // of `agent` and records what it shows.
  const previewing = (p) => {
    const shown = { text: null };
    const editor = Object.create(Editor.prototype);
    Object.assign(editor, {
      pane: p,
      on: true,
      asked: 0,
      promptProblem: null,
      promptText: { set_value: (text) => (shown.text = text) },
    });
    return { editor, shown };
  };

  test("asks for the prompt of the pipeline shown", async () => {
    const { p, cx, pending, flush } = await pane();
    const { editor } = previewing(p);
    editor.preview(agent, cx);
    expect((await next(pending, flush)).args).toEqual(["pipeline", "prompt", "alpha", "review"]);
  });

  test("asks for the prompt of the definition shown, by the definition-local block id", async () => {
    const { p, cx, pending, flush } = await pane();
    p.openDefinition("loop", cx);
    (await next(pending, flush)).ok(reading("loop"));
    await flush();
    const { editor, shown } = previewing(p);
    editor.preview(agent, cx);
    const read = await next(pending, flush);
    expect(read.args).toEqual(["composite", "prompt", "loop", "review"]);
    read.ok("DEFINITION PROMPT");
    await flush();
    expect(shown.text).toContain("DEFINITION PROMPT");
  });

  test("while a definition is only being opened, the prompt still follows the drawing shown", async () => {
    const { p, cx, pending, flush } = await pane();
    p.openDefinition("loop", cx);
    const { editor } = previewing(p);
    editor.preview(agent, cx);
    await next(pending, flush);
    expect((await next(pending, flush)).args.slice(0, 2)).toEqual(["pipeline", "prompt"]);
  });
});

describe("pending editor actions across navigation", () => {
  const withEditor = (p) => {
    const editor = Object.assign(Object.create(Editor.prototype), {
      pane: p,
      on: true,
      inserting: null,
      rejoining: null,
      addingSource: false,
      follow() {},
      load() {},
    });
    p.editor = editor;
    return editor;
  };
  const wire = { from: "review", port: "exit:approved" };
  const pendings = {
    rejoining: (e) => (e.rejoining = { ...wire, label: "approved" }),
    inserting: (e) => (e.inserting = { ...wire, to: "done" }),
  };

  for (const action of ["rejoining", "inserting"]) {
    test(`${action} in a pipeline does not survive opening a definition`, async () => {
      const { p, cx, pending, flush } = await pane();
      const editor = withEditor(p);
      pendings[action](editor);
      p.openDefinition("loop", cx);
      (await next(pending, flush)).ok(reading("loop"));
      await flush();
      expect(editor[action]).toBeNull();
      expect(editor.clickedBlock({ id: "loop.a" }, cx)).toBe(false);
      expect(pending).toHaveLength(0);
    });

    test(`${action} in a definition does not survive going back to the pipeline`, async () => {
      const { p, cx, pending, flush } = await pane();
      const editor = withEditor(p);
      p.openDefinition("loop", cx);
      (await next(pending, flush)).ok(reading("loop"));
      await flush();
      pendings[action](editor);
      p.closeDefinition(cx);
      (await next(pending, flush)).ok(reading("pipeline-alpha"));
      await flush();
      expect(editor[action]).toBeNull();
      // A click on `done` must not send a change for the definition's wire to the project's pipeline.
      expect(editor.clickedBlock({ id: "done" }, cx)).toBe(false);
      expect(pending).toHaveLength(0);
    });
  }

  test("a pending rejoin stays while the same target is read again", async () => {
    const { p, cx, pending, flush } = await pane();
    const editor = withEditor(p);
    pendings.rejoining(editor);
    p.loadDrawing(cx);
    (await next(pending, flush)).ok(reading("pipeline-alpha"));
    await flush();
    expect(editor.rejoining).not.toBeNull();
  });
});
