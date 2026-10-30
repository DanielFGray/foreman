import { Option } from "effect"
import { expect, test } from "vitest"
import type { Space } from "../shared/Fleet.ts"
import { onMachine } from "./FleetModel.ts"

// The shape herdr-app wrote on cynic for `space.new --machine cynic`.
const remote: Space = {
  id: "spfb",
  name: "probe",
  folder: "",
  tabs: [
    {
      id: "tb75",
      name: "",
      root: {
        _tag: "Split",
        type: "row",
        id: "tb75",
        size: Option.none(),
        children: [
          { _tag: "Block", type: "block", id: "p2e7", size: Option.none(), content: { _tag: "Terminal", terminal: "t4" } },
          { _tag: "Block", type: "block", id: "p3a1", size: Option.none(), content: { _tag: "Mod", mod: "notes" } },
        ],
      },
    },
  ],
}

test("onMachine addresses a remote space, its tabs, panes and terminals as herdr-app does", () => {
  expect(onMachine("cynic")(remote)).toEqual({
    ...remote,
    id: "cynic/spfb",
    tabs: [
      {
        id: "cynic/tb75",
        name: "",
        root: {
          _tag: "Split",
          type: "row",
          id: "cynic/tb75",
          size: Option.none(),
          children: [
            { _tag: "Block", type: "block", id: "cynic/p2e7", size: Option.none(), content: { _tag: "Terminal", terminal: "cynic/t4" } },
            { _tag: "Block", type: "block", id: "cynic/p3a1", size: Option.none(), content: { _tag: "Mod", mod: "notes" } },
          ],
        },
      },
    ],
  })
})
