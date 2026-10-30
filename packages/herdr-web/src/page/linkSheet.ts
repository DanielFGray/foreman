// The sheet a terminal link opens: its whole address, since the terminal's
// output chose it and a tap on a phone is easy to make by mistake. Open is a
// plain link, so the browser opens the tab at the tap itself; only http and
// https addresses get one.
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { CopyText } from "./commands.ts"
import { LinkSheet, Message, type Model, type UpdateReturn } from "./model.ts"
import { sheetView } from "./sheet.ts"
import { webAddress } from "./terminalLinks.ts"

export const pointedAtLink = (model: Model, uri: string): Model => withLinkSheet(model, () => LinkSheet.Showing({ uri, note: Option.none() }))

export const closedLinkSheet = (model: Model): Model => withLinkSheet(model, () => LinkSheet.Closed())

export const copiedLink = (model: Model): UpdateReturn =>
  model.linkSheet._tag === "Showing" ? { model, commands: [CopyText({ text: model.linkSheet.uri })] } : { model }

/** The last copy's outcome, shown under the address. */
export const notedLink = (model: Model, note: string): Model =>
  withLinkSheet(model, (sheet) => (sheet._tag === "Showing" ? LinkSheet.Showing({ ...sheet, note: Option.some(note) }) : sheet))

export const linkSheetView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  LinkSheet.match(model.linkSheet, {
    Closed: () => [],
    Showing: ({ uri, note }) => {
      const href = webAddress(uri)
      return [
        sheetView(
          "Open link?",
          Message.ClosedLinkSheet(),
          [
            h.p([h.Class("note")], ["The terminal's output gave this address. Check it before you open it."]),
            h.p([h.Class("link-address")], [uri]),
            ...(Option.isNone(href) ? [h.p([h.Class("note")], ["Only http and https addresses open from here."])] : []),
            ...Option.toArray(Option.map(note, (text) => h.p([h.Class("note"), h.AriaLive("polite")], [text]))),
            h.div(
              [h.Class("sheet-foot")],
              [
                ...Option.toArray(
                  Option.map(href, (address) =>
                    h.a([h.Class("chip"), h.Href(address), h.Target("_blank"), h.Rel("noopener noreferrer"), h.OnClick(Message.ClosedLinkSheet())], ["Open"]),
                  ),
                ),
                h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClickedCopyLink())], ["Copy"]),
                h.button([h.Type("button"), h.Class("chip"), h.OnClick(Message.ClosedLinkSheet())], ["Cancel"]),
              ],
            ),
          ],
          h,
        ),
      ]
    },
  })

const withLinkSheet = (model: Model, change: (sheet: LinkSheet) => LinkSheet): Model => modifyFields(model, { linkSheet: change })
