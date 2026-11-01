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

/** The machine as a Mermaid `stateDiagram-v2`: one arrow per allowed move, labelled with its event. */
export const toMermaid = <State extends string, Event extends string>(
  machine: Machine<State, Event>,
): string =>
  [
    "stateDiagram-v2",
    `  %% ${machine.id}`,
    ...machine.initial.map((state) => `  [*] --> ${state}`),
    ...machine.events.flatMap((event) =>
      sourcesOf(machine, event).map(
        (source) => `  ${source} --> ${machine.on[event][source]}: ${event}`,
      ),
    ),
  ].join("\n");
