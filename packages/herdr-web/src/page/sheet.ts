// A sheet: a panel in the workspace's column, over the soft keys, with a
// title and a close button. It is not fixed to the window, so it stays in
// the part of the page a phone shows above its keyboard.
import type { Html, HtmlBuilder } from "foldkit/html"
import type { Message } from "./model.ts"

export const sheetView = (title: string, close: Message, body: ReadonlyArray<Html>, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("sheet"), h.Role("dialog"), h.AriaLabel(title)],
    [
      h.div(
        [h.Class("sheet-head")],
        [h.h2([], [title]), h.button([h.Type("button"), h.Class("chip"), h.AriaLabel("close the sheet"), h.OnClick(close)], ["×"])],
      ),
      ...body,
    ],
  )
