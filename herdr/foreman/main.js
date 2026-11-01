// The foreman panel: the fleet as the daemon last published it, filtered to the
// shown space's project, with each row's one-shot commands as buttons.
//
// It reads state.json and runs `foreman <action> <id>` and `foreman policy ...`;
// it keeps nothing of its own. The policy is the daemon's to read: a button
// here rewrites the file through the CLI, and the next reading shows it. The file's shape is `Published` in foreman's src/published.ts.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, exec, readTextFile, watchFolder, theme, notify, props, home } from "herdr";

const VERSION = 2;
const STEPS = ["author", "climb", "review", "land"];
// Older than this, the reading is no longer the daemon working: it is gone or
// wedged inside a tick, and the panel says so rather than showing it as live.
const STALE_MS = 120000;
const SECTIONS = [
  ["attention", "Needs you"],
  ["working", "Working"],
  ["review", "Review"],
  ["queue", "Queue"],
  ["quota", "Accounts"],
  ["landed", "Landed"],
];
// These take an answer the panel has no input for yet; the CLI takes them.
const NEEDS_INPUT = new Set(["complete", "intervene"]);
// These end an agent or give up a claim, so a first click only arms them.
const DESTRUCTIVE = new Set(["kill", "close", "release"]);
// A row's key is a task id, a workspace label that holds one (`foreman/<id>`),
// or a project or account name, which has no task to show.
const TASK_ID = /\b(?:ts|ep)-[0-9a-f]{6}\b/;
// An open row shows this many of its task's newest log entries.
const LOGS_SHOWN = 3;

export default class Foreman extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.path = p.state ?? `${home()}/.local/state/foreman/state.json`;
    this.command = p.command ?? ["foreman"];
    this.published = null; this.problem = null; this.all = false;
    this.launching = null; this.rungs = []; this.busy = new Set(); this.landed = null;
    // The row shown whole, and each task's prog record as last read, by task id.
    this.opened = null; this.tasks = new Map();
    this.reload(cx);
    this.loadRungs(cx);
    this.watch(cx);
    // The age line counts up between readings, and a watch that failed is
    // tried again: the folder does not exist until a daemon first publishes.
    cx.timer.every(5000, (cx) => { if (!this.watching) this.watch(cx); cx.notify(); });
  }

  watch(cx) {
    const folder = this.path.slice(0, this.path.lastIndexOf("/"));
    this.watching = true;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const changed = await watchFolder(folder);
          if (changed.includes(this.path)) this.reload(cx);
        }
      } catch {
        this.watching = false;
        this.reload(cx);
      }
    });
  }

  reload(cx) {
    cx.spawn(async (cx) => {
      const text = await readTextFile(this.path);
      if (text === null) { this.published = null; this.problem = "no foreman daemon has published yet"; cx.notify(); return; }
      try {
        const published = JSON.parse(text);
        if (published.version !== VERSION) throw new Error(`state.json is version ${published.version}; this panel reads ${VERSION}`);
        this.announce(published);
        this.published = published; this.problem = null;
      } catch (error) { this.problem = String(error.message ?? error); }
      cx.notify();
    });
  }

  // Posts what the fleet finished since the last reading. The first reading
  // only records, so opening the panel does not replay history.
  announce(published) {
    const landed = new Set(published.rows.filter((row) => row.view === "landed").map((row) => row.key));
    if (this.landed) for (const row of published.rows) {
      if (row.view === "landed" && !this.landed.has(row.key)) notify({ title: `Landed ${row.key}`, body: row.label, level: "success", timeout: 8000 });
    }
    this.landed = landed;
  }

  loadRungs(cx) {
    cx.spawn(async (cx) => {
      const result = await this.foreman(["ladder", "list", "--json"]);
      if (result.code === 0) { try { this.rungs = JSON.parse(result.stdout).filter((rung) => rung.state !== "disabled"); } catch {} }
      cx.notify();
    });
  }

  // Opens a row whole, and reads its task from prog again each time it opens:
  // the reading only carries a title, and a log grows while the task is worked.
  toggleDetail(key, cx) {
    this.opened = this.opened === key ? null : key;
    cx.notify();
    const id = this.opened && key.match(TASK_ID)?.[0];
    if (!id) return;
    cx.spawn(async (cx) => {
      const result = await exec("prog", ["show", id, "--json"]);
      try {
        this.tasks.set(id, result.code === 0 ? JSON.parse(result.stdout) : { error: (result.stderr || result.stdout).trim() });
      } catch (error) { this.tasks.set(id, { error: `prog's answer is not JSON: ${error.message}` }); }
      cx.notify();
    });
  }

  foreman(args) {
    const [program, ...rest] = this.command;
    return exec(program, [...rest, ...args]);
  }

  // Runs one command for a row, then reads the file again: a one-shot command
  // changes the world, not the daemon, so its effect shows on the next tick.
  act(args, cx) {
    const id = args.join(" ");
    if (this.busy.has(id)) return;
    this.busy.add(id); this.launching = null; this.armed = null; cx.notify();
    cx.spawn(async (cx) => {
      const result = await this.foreman(args);
      this.busy.delete(id);
      if (result.code !== 0) notify({ title: `foreman ${id} failed`, body: (result.stderr || result.stdout).trim().slice(-400), level: "error" });
      this.reload(cx);
    });
  }

  // The managed project whose checkout the shown space is in: its folder at or
  // under the checkout, the rule foreman places a task's tab by. A space's name
  // is only a label, and a renamed one would hide every row.
  project() {
    const folder = spaces().find((space) => space.active)?.folder;
    if (!folder) return null;
    const found = (this.published?.projects ?? []).find((p) => folder === p.directory || folder.startsWith(`${p.directory}/`));
    return found?.name ?? null;
  }

  render(cx) {
    const t = theme(), published = this.published, project = this.project();
    const age = published?.observedAt ? Date.now() - Date.parse(published.observedAt) : null;
    const live = age !== null && age < STALE_MS;
    const policy = published?.policy;
    const state = !published ? "offline" : !published.daemon ? "no daemon" : !live ? "stale" : policy.paused ? "paused" : Object.values(policy.default).some(Boolean) || policy.grants.length > 0 ? "running" : "idle";
    const rows = (published?.rows ?? []).filter((row) => this.all || project === null || row.project === null || row.project === project);
    const hidden = (published?.rows.length ?? 0) - rows.length;

    const chip = (id, label, onClick, tone) => div().id(id).px(6).py(1).rounded(5).text_size(11).cursor_pointer()
      .bg(t.raised).text_color(tone ?? t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);

    const row = (r) => {
      const actions = r.actions.filter((action) => !NEEDS_INPUT.has(action));
      const launchable = r.view === "queue";
      const open = this.opened === r.key;
      return v_flex().id(`row-${r.view}-${r.key}`).px(10).py(6).gap(3).rounded(7).cursor_pointer()
        .when(open, (el) => el.bg(t.raised)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); this.armed = null; this.toggleDetail(r.key, cx); })
        .child(h_flex().gap(8).items_start().min_w(0)
          .child(div().flex_none().text_size(11).text_color(t.dim).child(r.key))
          .child(div().flex_1().min_w(0).when(!open, (el) => el.truncate()).child(r.label)))
        .when(Boolean(r.detail), (el) => el.child(div().text_size(11).text_color(t.muted).when(!open, (el) => el.truncate()).child(r.detail)))
        .when(actions.length > 0 || launchable, (el) => el.child(h_flex().gap(4).flex_wrap()
          .when(launchable, (el) => el.child(chip(`launch-${r.key}`, this.launching === r.key ? "cancel" : "launch",
            (cx) => { this.launching = this.launching === r.key ? null : r.key; cx.notify(); }, t.working)))
          .when(r.view === "review", (el) => el.children(["review", "land"].map((step) =>
            chip(`allow-${step}-${r.key}`, this.busy.has(`policy grant ${r.key} ${step} --count 1`) ? `${step}…` : `allow ${step}`,
              (cx) => this.act(["policy", "grant", r.key, step, "--count", "1"], cx)))))
          .children(actions.map((action) => {
            const id = `${action} ${r.key}`, armed = this.armed === id;
            const label = this.busy.has(id) ? `${action}…` : armed ? `${action}?` : action;
            return chip(`${action}-${r.key}`, label, (cx) => {
              if (DESTRUCTIVE.has(action) && !armed) { this.armed = id; cx.notify(); return; }
              this.act([action, r.key], cx);
            }, armed ? t.blocked : undefined);
          }))))
        .when(this.launching === r.key, (el) => el.child(h_flex().gap(4).flex_wrap()
          .children(this.rungs.map((rung) => chip(`rung-${r.key}-${rung.rung}`, rung.rung,
            (cx) => this.act(["dispatch", r.key, "--rung", rung.rung], cx), t.foreground)))))
        .when(open, (el) => el.child(taskView(r.key)));
    };

    // The open row's task as prog records it; a row with no task id shows only its whole title and detail.
    const taskView = (key) => {
      const id = key.match(TASK_ID)?.[0];
      const task = id ? this.tasks.get(id) : undefined;
      const note = (text, tone) => div().text_size(11).text_color(tone ?? t.muted).child(text);
      if (!id) return div();
      if (!task) return note("reading the task…");
      if (task.error) return note(task.error, t.blocked);
      const facts = [task.type === "epic" ? "epic" : null, task.status, `priority ${task.priority}`, task.project, task.parent ? `under ${task.parent}` : null, ...task.labels].filter(Boolean);
      const logs = task.logs.slice(-LOGS_SHOWN).reverse();
      return v_flex().gap(6).pt(4).border_t(1).border_color(t.border)
        .child(note(facts.join(" · ")))
        .when(Boolean(task.description), (el) => el.child(div().text_size(12).child(task.description)))
        .when(Boolean(task.definition_of_done), (el) => el.child(note(`Done when: ${task.definition_of_done}`)))
        .children(logs.map((log, i) => v_flex().id(`log-${id}-${i}`).gap(1)
          .child(note(log.created_at.slice(0, 16).replace("T", " "), t.dim))
          .child(div().text_size(11).child(log.message))))
        .when(task.logs.length > LOGS_SHOWN, (el) => el.child(note(`${task.logs.length - LOGS_SHOWN} older log entries: prog show ${id}`, t.dim)));
    };

    const section = ([view, title]) => {
      const mine = rows.filter((r) => r.view === view);
      if (mine.length === 0) return null;
      return v_flex().gap(1).pt(8)
        .child(h_flex().px(10).gap(6).text_size(11).text_color(view === "attention" ? t.blocked : t.dim)
          .child(title.toUpperCase()).child(String(mine.length)))
        .children(mine.map(row));
    };

    const tone = state === "running" ? t.working : state === "stale" ? t.blocked : t.muted;

    // The policy: pause, the steps the fleet takes for every task, and the
    // agent limit. A grant for one task is the "allow" chip on its row.
    const controls = !policy ? null : v_flex().px(14).py(6).gap(4).border_b(1).border_color(t.border)
      .when(Boolean(published.policyError), (el) => el.child(div().text_size(11).text_color(t.blocked).child(published.policyError)))
      .child(h_flex().gap(4).flex_wrap().items_center()
        .child(chip("pause", policy.paused ? "resume" : "pause", (cx) => this.act(["policy", policy.paused ? "resume" : "pause"], cx), policy.paused ? t.working : t.blocked))
        .children(STEPS.map((step) => chip(`step-${step}`, `${policy.default[step] ? "●" : "○"} ${step}`,
          (cx) => this.act(["policy", "set", step, policy.default[step] ? "off" : "on"], cx), policy.default[step] ? t.foreground : t.muted)))
        .child(div().flex_1())
        // One group, so a narrow dock wraps the agent limit whole.
        .child(h_flex().flex_none().gap(4).items_center()
          .child(chip("slots-down", "−", (cx) => this.act(["policy", "slots", String(Math.max(1, policy.slots - 1))], cx)))
          .child(div().text_size(11).text_color(t.muted).child(`${policy.slots} agents`))
          .child(chip("slots-up", "+", (cx) => this.act(["policy", "slots", String(policy.slots + 1)], cx)))))
      .when(policy.grants.length > 0, (el) => el.children(policy.grants.map((g) => h_flex().gap(6).items_center().text_size(11).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(`${g.scope}: ${g.steps.join(", ")}${g.remaining === undefined ? "" : ` · ${g.admitted.length}/${g.remaining} tasks`}`))
        .child(chip(`revoke-${g.scope}`, "revoke", (cx) => this.act(["policy", "revoke", g.scope], cx))))));
    return v_flex().id("foreman").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_click((_e, cx) => { if (this.armed) { this.armed = null; cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().child("Foreman"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(tone).child(state))
        .when(age !== null, (el) => el.child(div().text_size(10).text_color(t.dim).child(`${Math.round(age / 1000)}s ago`)))
        .child(div().flex_1())
        .child(chip("scope", this.all || project === null ? "all projects" : project, (cx) => { this.all = !this.all; cx.notify(); })))
      .when(controls !== null, (el) => el.child(controls))
      .child(v_flex().id("foreman-rows").flex_1().min_h(0).overflow_y_scrollbar().px(4).pb(8)
        .when(Boolean(this.problem), (el) => el.child(div().p(12).text_color(t.muted).child(this.problem)))
        .when(!this.problem && rows.length === 0, (el) => el.child(div().p(12).text_color(t.muted)
          .child(hidden > 0 ? `nothing for ${project}; ${hidden} rows in other projects` : "nothing queued, working or waiting")))
        .children(SECTIONS.map(section).filter(Boolean)));
  }
}
