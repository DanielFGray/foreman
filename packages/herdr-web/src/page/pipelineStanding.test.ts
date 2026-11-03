import { expect, test } from "vitest"
import type { PipelineNode } from "foreman/pipeline"
import type { ForemanPlacement } from "../shared/Foreman.ts"
import { countsOf, tasksAt } from "./pipelineStanding.ts"

const at = (key: string, node: string, state: ForemanPlacement["state"], gates: ForemanPlacement["gates"] = [], stands = node): ForemanPlacement => ({ key, label: key, project: "app", node, stands, state, gates, column: "queue", grant: null, runs: [] })

const park: PipelineNode = { kind: "park", id: "attention" }
const gate: PipelineNode = { kind: "gate", id: "start", step: "author", next: "author" }
const router: PipelineNode = { kind: "router", id: "retry", routes: [], else: "start" }

test("a block holds the tasks foreman draws on it", () => {
  const tasks = [at("a", "attention", "parked"), at("b", "author", "waiting", [{ id: "start", step: "author" }], "start"), at("c", "author", "running")]
  expect(tasksAt(park, tasks).map((t) => t.key)).toEqual(["a"])
  expect(tasksAt(gate, tasks).map((t) => t.key)).toEqual(["b"])
  expect(tasksAt(router, tasks)).toEqual([])
})

test("counts name each state present, in the order a task goes through them", () => {
  expect(countsOf([at("a", "x", "running"), at("b", "x", "waiting"), at("c", "x", "waiting")])).toBe("2 waiting, 1 running")
  expect(countsOf([at("a", "attention", "parked")])).toBe("1 parked")
})
