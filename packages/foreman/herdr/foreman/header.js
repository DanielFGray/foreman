// The Foreman pane's header, over every view: the view switch, the project,
// what the dispatcher is doing and how old its reading is, pause or resume,
// the agent limit, the fleet defaults chip, and the alerts.
//
// The fleet defaults strip opens from its chip: each step's fleet-wide mode
// (`foreman policy set <step> <next>`) and every grant with a revoke. A
// project's own mode for a step is on that step's gate in the Pipeline view.
// Every button runs `foreman policy ...`, and the next reading shows the change.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { chip } from "./parts.js";
import { dispatcherState, NEXT_MODE } from "./status.js";

const STEPS = ["author", "climb", "review", "publish", "land"];
const VIEWS = [["pipeline", "Pipeline"], ["tasks", "Tasks"], ["models", "Models"]];

export class Header {
  constructor(pane) {
    this.pane = pane;
    this.defaultsOpen = false;
  }

  view(t) {
    const pane = this.pane, published = pane.published;
    const { state, age } = dispatcherState(published, Date.now());
    const policy = published?.policy;
    const tone = state === "running" ? t.working : state === "stale" || state === "failed" ? t.blocked : t.muted;
    return v_flex().flex_none().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().flex_wrap().px(10).py(6).gap_x(10).gap_y(4).items_center()
        .child(this.switch(t))
        .child(div().font_semibold().child(pane.project() ?? "no project"))
        .child(div().px(5).rounded(4).border(1).border_color(t.border).text_size(10).text_color(tone).child(state))
        .when(age !== null, (el) => el.child(div().text_size(10).text_color(t.dim).child(`${Math.round(age / 1000)}s ago`)))
        .when(policy !== undefined, (el) => el
          .child(chip(t, policy.paused ? "resume" : "pause", "pause", (cx) => pane.act(["policy", policy.paused ? "resume" : "pause"], cx, notify)))
          .child(h_flex().gap(4).items_center()
            .child(chip(t, "−", "slots-down", (cx) => pane.act(["policy", "slots", String(Math.max(1, policy.slots - 1))], cx, notify)))
            .child(div().text_color(t.muted).child(`${policy.slots} agents`))
            .child(chip(t, "+", "slots-up", (cx) => pane.act(["policy", "slots", String(policy.slots + 1)], cx, notify))))
          .child(chip(t, this.defaultsOpen ? "hide fleet defaults" : "fleet defaults", "fleet-defaults", (cx) => { this.defaultsOpen = !this.defaultsOpen; cx.notify(); })))
        .child(div().flex_1())
        .when(pane.busy, (el) => el.child(div().text_color(t.muted).child("…")))
        .when(pane.problem !== null, (el) => el.child(div().text_color(t.blocked).truncate().child(pane.problem))))
      .when(this.defaultsOpen && policy !== undefined, (el) => el.child(this.defaults(t, policy)))
      .children(this.alerts().map((alert) => div().px(10).pb(4).text_size(11).text_color(t.blocked).child(alert)));
  }

  // The view switch. The drawing is read when the Pipeline view first shows,
  // and the ladder each time the Models view shows.
  switch(t) {
    const pane = this.pane;
    return h_flex().gap(4).children(VIEWS.map(([mode, label]) =>
      div().id(`mode-${mode}`).px(6).rounded(4).border(1)
        .border_color(pane.mode === mode ? t.accent : t.border).text_color(pane.mode === mode ? t.accent : t.foreground)
        .hover((s) => s.bg(t.hover))
        .on_click((_event, cx) => pane.show(mode, cx))
        .child(label)));
  }

  // The fleet-wide mode of each step, and each grant with its revoke.
  defaults(t, policy) {
    const pane = this.pane;
    return v_flex().px(10).pb(6).gap(4)
      .child(h_flex().flex_wrap().gap(4).items_center()
        .child(div().text_color(t.muted).child("every project:"))
        .children(STEPS.map((step) => chip(t, `${step} ${policy.default[step]}`, `default-${step}`,
          (cx) => pane.act(["policy", "set", step, NEXT_MODE[policy.default[step]]], cx, notify)))))
      .when(policy.grants.length === 0, (el) => el.child(div().text_color(t.dim).child("no grants")))
      .children(policy.grants.map((g) => h_flex().gap(6).items_center().text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().child(`${g.scope}: ${g.steps.join(", ")}${g.remaining === undefined ? "" : ` · ${g.admitted.length}/${g.remaining} tasks`}`))
        .child(chip(t, "revoke", `revoke-${g.scope}`, (cx) => pane.act(["policy", "revoke", g.scope], cx, notify)))));
  }

  // What stops the fleet or this project, in words: an unreadable policy, a
  // failed dispatcher, a tracker that did not answer, a pipeline that cannot run.
  alerts() {
    const published = this.pane.published, project = this.pane.project();
    if (!published) return [];
    const mine = (published.projects ?? []).find((p) => p.name === project);
    const stopped = (published.stopped ?? []).find((s) => s.project === project);
    return [
      published.policyError,
      published.dispatcher?.state === "failed" ? `dispatcher failed, restarting: ${published.dispatcher.detail}` : null,
      mine?.unreachable ? `the ${mine.tracker} tracker did not answer, so no task takes a step: ${mine.unreachable}` : null,
      ...(stopped?.problems ?? []).map((problem) => `the pipeline cannot run: ${problem}`),
    ].filter(Boolean);
  }
}

const notify = (_done, cx) => cx.notify();
