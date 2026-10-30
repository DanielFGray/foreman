// The bridge's side of each coding agent: one adapter per agent, holding the
// features src/shared/Harness.ts lists for it. A handler asks for a feature of
// the agent in a terminal; an agent that lacks it fails the call.
import { Context, Effect, Layer, Option, Record, type Stream } from "effect"
import { Hc } from "../hc/Hc.ts"
import { BridgeError } from "../shared/Api.ts"
import type { Answer, ChatUpdate, InputBox, Question } from "../shared/Chat.ts"
import type { Terminal } from "../shared/Fleet.ts"
import { type Feature, harnessOf, type HarnessId, type HarnessWith } from "../shared/Harness.ts"
import type { SlashCommand } from "../shared/SlashCommand.ts"
import { claudeCode } from "./claude/ClaudeCode.ts"
import { openCode } from "./opencode/OpenCode.ts"
import { toBridgeError } from "./hcError.ts"

/** What each feature takes from an adapter. Each acts on the terminal as hc reported it just now. */
export type Features = {
  /** The conversation, whole at first and then as it grows. */
  chat: (terminal: Terminal) => Stream.Stream<ChatUpdate, BridgeError>
  model: {
    /** The id of the model that answers, each time it changes; none before the first answer. */
    watch: (terminal: Terminal) => Stream.Stream<Option.Option<string>, BridgeError>
    /** Switches to a model the agent's picker offers, by its alias. */
    pick: (terminal: Terminal, alias: string) => Effect.Effect<void, BridgeError>
  }
  inputBox: {
    watch: (terminal: Terminal) => Stream.Stream<InputBox, BridgeError>
    /** Why a message must not go now, such as text typed in the box; none when it may. */
    refusal: (terminal: Terminal, whileWorking: boolean) => Effect.Effect<Option.Option<BridgeError>, BridgeError>
    /** Replaces the box's text, when it still holds `expected`; the box as it reads after. See `writeInputBox` in Api.ts. */
    write: (terminal: Terminal, expected: string, text: string) => Effect.Effect<InputBox, BridgeError>
  }
  questions: {
    /** The question the agent waits on, once it shows; none when it asks nothing. */
    read: (terminal: Terminal) => Effect.Effect<Option.Option<Question>, BridgeError>
    answer: (terminal: Terminal, question: Question, answer: Answer) => Effect.Effect<void, BridgeError>
  }
  commands: (terminal: Terminal) => Effect.Effect<ReadonlyArray<SlashCommand>, BridgeError>
}

export class Agents extends Context.Service<Agents>()("herdr-web/server/Agents", {
  make: Effect.gen(function* () {
    const hc = yield* Hc
    const claude = yield* claudeCode
    const opencode = yield* openCode
    // Feature first, so each lists exactly the agents that offer it.
    const adapters: { readonly [F in Feature]: Record.ReadonlyRecord<string, Features[F]> } = {
      chat: { "claude-code": claude.chat, opencode: opencode.chat },
      model: { "claude-code": claude.model },
      inputBox: { "claude-code": claude.inputBox },
      questions: { "claude-code": claude.questions },
      commands: { "claude-code": claude.commands },
    } satisfies { readonly [F in Feature]: { readonly [Id in HarnessWith<F>]: Features[F] } & { readonly [Id in Exclude<HarnessId, HarnessWith<F>>]?: never } }

    const terminalOf = (address: string) => Effect.mapError(hc.get(address), toBridgeError)
    const featureOf = <F extends Feature>(terminal: Terminal, feature: F) =>
      Option.flatMap(harnessOf(terminal), ({ id }) => Record.get(adapters[feature], id))

    return {
      /** The terminal and the feature of its agent; fails when the agent lacks it. */
      use: <F extends Feature>(address: string, feature: F) =>
        Effect.flatMap(terminalOf(address), (terminal) =>
          Option.match(featureOf(terminal, feature), {
            onNone: () => Effect.fail(new BridgeError({ kind: "unsupported", message: `this terminal's program has no ${feature} the page can read` })),
            onSome: (implementation) => Effect.succeed({ terminal, implementation }),
          }),
        ),
      /** The terminal and the feature of its agent, when the agent has it. */
      find: <F extends Feature>(address: string, feature: F) =>
        Effect.map(terminalOf(address), (terminal) => ({ terminal, implementation: featureOf(terminal, feature) })),
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
