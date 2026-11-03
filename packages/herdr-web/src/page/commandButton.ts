// A button that runs one foreman command, shared by the fleet column and the
// pipeline page's ladder panel, so both show a running or armed command alike.
import { Array, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { argvOf, type ForemanCommand } from "../shared/Foreman.ts"
import { type ForemanPage, Message } from "./model.ts"

/** The command line a command runs, which also names it while it is busy or armed. */
export const lineOf = (command: ForemanCommand) => argvOf(command).join(" ")

/** A button that runs one command: `name…` while it runs, `name?` while it waits for its second click. */
export const commandButton = (text: string, label: string, command: ForemanCommand, page: ForemanPage, h: HtmlBuilder<Message>, isOn = false): Html => {
  const line = lineOf(command)
  const isBusy = Array.contains(page.busy, line)
  const isArmed = Option.contains(page.armed, line)
  return h.button(
    [
      h.Type("button"),
      h.Class(isArmed ? "chip armed" : isOn ? "chip on" : "chip"),
      h.Title(line),
      h.AriaLabel(label),
      h.Disabled(isBusy),
      h.OnClick(Message.ClickedForemanCommand({ command })),
    ],
    [isBusy ? `${text}…` : isArmed ? `${text}?` : text],
  )
}
