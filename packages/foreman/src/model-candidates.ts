/**
 * Models foreman could register but has not: the models.dev catalog, kept to
 * the accounts the operator is signed in to.
 *
 * A login is read where its harness keeps it, as the quota probes do, and is
 * never copied. A candidate states what `foreman models add` needs (harness,
 * model id, provider, pool), because each harness names a model its own way:
 * opencode takes the catalog's `provider/model`, claude and codex take the bare
 * model id.
 */

import { Effect, FileSystem, Option, Schema as S } from "effect";
import type { Catalog } from "./model-advice-catalog.ts";

export interface Candidate {
  /** The id `foreman models add` registers, in the harness's own naming. */
  readonly model: string;
  readonly harness: string;
  /** The account it bills, in the registry's naming. */
  readonly provider: string;
  /** Quota pool to create or join: the catalog's provider name. */
  readonly pool: string;
  /** The catalog identity, `provider/model`. */
  readonly modelsDev: string;
  /** The catalog's display name for the model. */
  readonly name: string;
}

/** One signed-in account: a harness that can run its catalog provider's models. */
export interface Login {
  readonly harness: string;
  /** The provider's id in models.dev. */
  readonly catalogProvider: string;
}

/** Candidates for every login, minus the model ids the registry already lists. */
export const candidatesFrom = (
  catalog: Catalog,
  logins: ReadonlyArray<Login>,
  registered: ReadonlySet<string>,
): ReadonlyArray<Candidate> =>
  logins.flatMap((login) => {
    const provider = catalog[login.catalogProvider];
    if (provider?.models === undefined) return [];
    return Object.entries(provider.models).flatMap(([bare, entry]) => {
      if (entry.tool_call !== true || entry.status === "deprecated") return [];
      const model = login.harness === "opencode" ? `${login.catalogProvider}/${bare}` : bare;
      if (registered.has(model)) return [];
      return [
        {
          model,
          harness: login.harness,
          provider: registryProviderOf(login),
          pool: provider.name ?? login.catalogProvider,
          modelsDev: `${login.catalogProvider}/${bare}`,
          name: entry.name ?? bare,
        },
      ];
    });
  });

/** The registry names codex's openai account `openai-codex`; every other provider keeps its catalog id. */
const registryProviderOf = (login: Login): string =>
  login.harness === "codex" ? "openai-codex" : login.catalogProvider;

const OpencodeAuth = S.Record(S.String, S.Unknown);

/**
 * The accounts the operator is signed in to. opencode names each provider it
 * holds a key for; claude and codex each hold one account, whose file is the
 * login. A missing or unreadable file is no login.
 */
export const readLogins = (
  home: string,
): Effect.Effect<ReadonlyArray<Login>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = (path: string) => fs.readFileString(`${home}/${path}`).pipe(Effect.option);
    const opencode = yield* text(".local/share/opencode/auth.json");
    const held = Option.match(opencode, {
      onNone: () => [] as string[],
      onSome: (raw) =>
        S.decodeUnknownOption(S.fromJsonString(OpencodeAuth))(raw).pipe(
          Option.map(Object.keys),
          Option.getOrElse(() => [] as string[]),
        ),
    });
    const claude = Option.isSome(yield* text(".claude/.credentials.json"));
    const codex = Option.isSome(yield* text(".codex/auth.json"));
    return [
      ...held.map((catalogProvider) => ({ harness: "opencode", catalogProvider })),
      ...(claude ? [{ harness: "claude", catalogProvider: "anthropic" }] : []),
      ...(codex ? [{ harness: "codex", catalogProvider: "openai" }] : []),
    ];
  });
