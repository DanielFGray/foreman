// Small pieces the pipeline pane and its editor both draw.
import { div, PathBuilder } from "gpui-kit";
import { h_flex } from "gpui-base";

// Every wire as one stroked path over the whole drawing, with its label at its
// anchor. Across, a label sits above its level stretch. Down, it sits on its
// line as a tag, so the line reads as passing behind it.
export const wiresLayer = (drawing, z, t) => {
  const layer = div().absolute().left(0).top(0).size_full();
  const paths = drawing.wires.map((wire) => {
    const [first, ...rest] = wire.points;
    let path = PathBuilder.stroke(1.5).move_to(first[0] * z, first[1] * z);
    for (const [x, y] of rest) path = path.line_to(x * z, y * z);
    return window.paint_path(path.build(), t.border).absolute().left(0).top(0).size_full();
  });
  const down = drawing.flow === "down";
  const labels = drawing.wires.filter((wire) => wire.label !== "").map((wire) =>
    div().absolute().left(wire.anchor[0] * z - 50 * z).top(wire.anchor[1] * z - (down ? 7 : 14) * z).w(100 * z)
      .flex().justify_center()
      .child(div().text_size(10 * z).text_color(t.muted).when(down, (el) => el.px(3 * z).rounded(3).bg(t.canvas))
        .child(wire.label)));
  return layer.children([...paths, ...labels]);
};

export const chip = (t, label, id, onClick) =>
  div().id(id).px(6).rounded(4).border(1).border_color(t.border).hover((s) => s.bg(t.hover))
    .on_click((_event, cx) => onClick(cx)).child(label);

// One choice among a few, the current one marked.
export const picker = (t, label, choices, current, onPick) =>
  h_flex().flex_wrap().gap(6).items_center()
    .child(div().w(64).text_color(t.muted).child(label))
    .children(choices.map((choice) => div().id(`${label}-${choice}`).px(6).rounded(4).border(1)
      .border_color(choice === current ? t.accent : t.border).text_color(choice === current ? t.accent : t.foreground)
      .hover((s) => s.bg(t.hover))
      .on_click((_event, cx) => { if (choice !== current) onPick(choice, cx); })
      .child(choice)));

// What a refused foreman command said: its error's message, without the log
// prefix and the stack under it.
export const refusalOf = (result) => {
  const text = result.stderr.split("\n    at ")[0].trim();
  return text.replace(/^.*?Error: /s, "") || `foreman exited ${result.code}`;
};

// A wire's way out of its block in words: its label, or the port foreman names it by.
export const portName = (wire) => wire.label || (typeof wire.port === "number" ? `route ${wire.port}` : String(wire.port));
