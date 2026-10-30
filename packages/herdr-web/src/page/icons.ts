// Lucide icons (https://lucide.dev, ISC), drawn as inline SVG in the text
// colour. Each icon is lucide's list of SVG child elements; import only the
// icons the page uses, from `lucide`, so the rest stay out of the bundle.
import { Array, Match, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { IconNode } from "lucide"

export type { IconNode } from "lucide"

export {
  Activity,
  BookOpen,
  Bot,
  Circle,
  CircleCheck,
  CircleDot,
  Clock,
  CodeXml,
  Columns2,
  ExternalLink,
  FlaskConical,
  Folder,
  FolderPlus,
  GitBranch,
  Hammer,
  KeyRound,
  Maximize2,
  MessageSquare,
  Minimize2,
  Monitor,
  Pencil,
  PanelLeft,
  Plus,
  Play,
  RefreshCw,
  Rows2,
  Server,
  Settings,
  SquarePen,
  SquareTerminal,
  Trash2,
  X,
} from "lucide"

/** The icon, sized to the text; a reader skips it, so give its button a label. */
export const icon = <M>(node: IconNode, h: HtmlBuilder<M>): Html =>
  h.svg(
    [
      h.Class("icon"),
      h.AriaHidden(true),
      h.ViewBox("0 0 24 24"),
      h.Attribute("fill", "none"),
      h.Attribute("stroke", "currentColor"),
      h.StrokeWidth("2"),
      h.Attribute("stroke-linecap", "round"),
      h.Attribute("stroke-linejoin", "round"),
    ],
    Array.getSomes(Array.map(node, ([tag, attributes]) => child(tag, attributes, h))),
  )

/**
 * A product's mark from Simple Icons (https://simpleicons.org, CC0): one
 * filled path on the same 24-unit grid, in the text colour.
 */
export const mark = <M>(path: string, h: HtmlBuilder<M>): Html =>
  h.svg([h.Class("icon"), h.AriaHidden(true), h.ViewBox("0 0 24 24"), h.Attribute("fill", "currentColor")], [h.path([h.Attribute("d", path)], [])])

// Lucide draws with these few shapes; a shape outside them is left out.
const child = <M>(tag: string, attributes: Readonly<Record<string, string | number | undefined>>, h: HtmlBuilder<M>): Option.Option<Html> => {
  const attrs = Array.getSomes(
    Array.map(Object.entries(attributes), ([name, value]) => Option.map(Option.fromNullishOr(value), (set) => h.Attribute(name, String(set)))),
  )
  return Match.value(tag).pipe(
    Match.when("path", () => Option.some(h.path(attrs, []))),
    Match.when("circle", () => Option.some(h.circle(attrs, []))),
    Match.when("rect", () => Option.some(h.rect(attrs, []))),
    Match.when("line", () => Option.some(h.line(attrs, []))),
    Match.when("polyline", () => Option.some(h.polyline(attrs, []))),
    Match.when("polygon", () => Option.some(h.polygon(attrs, []))),
    Match.when("ellipse", () => Option.some(h.ellipse(attrs, []))),
    Match.orElse(() => Option.none()),
  )
}
