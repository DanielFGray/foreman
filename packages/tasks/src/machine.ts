/**
 * A finite state machine as data: states, events, and the one state each
 * event leads to from each state. Modelled on xstate's machines and drawn
 * the way its visualiser draws them, as a Mermaid state diagram.
 *
 * A transition the table does not list is refused. That is the point of
 * writing the machine down: every status change a command can make is one
 * row here, and a reader sees all of them in one diagram.
 */
import { Option } from "effect";

export interface Machine<State extends string, Event extends string> {
  readonly id: string;
  readonly states: ReadonlyArray<State>;
  readonly events: ReadonlyArray<Event>;
  /** The states a new item may start in. */
  readonly initial: ReadonlyArray<State>;
  /** States no event leaves except the ones listed for them. Drawn as ends. */
  readonly final: ReadonlyArray<State>;
  /** For each event, the state it leads to from each state it may be sent in. */
  readonly on: { readonly [E in Event]: Partial<Record<State, State>> };
}

/** The state `event` leads to from `state`, or nothing when the machine refuses it. */
export const transition = <State extends string, Event extends string>(
  machine: Machine<State, Event>,
  state: State,
  event: Event,
): Option.Option<State> => Option.fromNullishOr(machine.on[event][state]);

/** The states `event` may be sent in. */
export const sourcesOf = <State extends string, Event extends string>(
  machine: Machine<State, Event>,
  event: Event,
): ReadonlyArray<State> => machine.states.filter((state) => machine.on[event][state] !== undefined);

/**
 * The machine as a Mermaid `stateDiagram-v2`.
 *
 * An event that every state accepts, always to the same state, is written once
 * in a note rather than as one arrow per state: those are the transitions that make a
 * machine permissive, and seven parallel arrows hide that instead of showing it.
 */
export const toMermaid = <State extends string, Event extends string>(
  machine: Machine<State, Event>,
): string => {
  const lines = ["stateDiagram-v2", `  %% ${machine.id}`];
  for (const state of machine.initial) lines.push(`  [*] --> ${state}`);
  const everywhere: Array<string> = [];
  for (const event of machine.events) {
    const sources = sourcesOf(machine, event);
    const targets = new Set(sources.map((source) => machine.on[event][source]));
    if (sources.length === machine.states.length && targets.size === 1) {
      everywhere.push(`${event} → ${[...targets][0]}`);
      continue;
    }
    for (const source of sources)
      lines.push(`  ${source} --> ${machine.on[event][source]}: ${event}`);
  }
  for (const state of machine.final) lines.push(`  ${state} --> [*]`);
  const first = machine.states[0];
  if (everywhere.length > 0 && first !== undefined) {
    lines.push(
      `  note right of ${first}`,
      `    from any state: ${everywhere.join(", ")}`,
      "  end note",
    );
  }
  return lines.join("\n");
};
