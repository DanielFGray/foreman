// What this browser keeps for itself, in its local storage: a phone and a
// desk each keep their own.
import { BrowserKeyValueStore } from "@effect/platform-browser"
import { Effect, Option, type Schema } from "effect"
import { KeyValueStore } from "effect/persistence"

/** The kept value, or the fallback when there is none, it is from another version, or storage is closed to the page (a private window). */
export const loadStored = <S extends Schema.Constraint>(key: string, schema: S, fallback: S["Type"]) =>
  Effect.gen(function* () {
    const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, schema)
    return Option.getOrElse(yield* store.get(key), () => fallback)
  }).pipe(
    Effect.catchTags({
      KeyValueStoreError: (error) => Effect.logWarning(`the kept ${key} cannot be read`, error).pipe(Effect.as(fallback)),
      SchemaError: (error) => Effect.logWarning(`the kept ${key} is from another version`, error).pipe(Effect.as(fallback)),
    }),
    Effect.provide(BrowserKeyValueStore.layerLocalStorage),
  )

/** Keeps the value; a failure only costs the next load its value, so it is logged and dropped. */
export const saveStored = <S extends Schema.Constraint>(key: string, schema: S, value: S["Type"]) =>
  Effect.gen(function* () {
    const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, schema)
    yield* store.set(key, value)
  }).pipe(
    Effect.catchTags({
      KeyValueStoreError: (error) => Effect.logWarning(`the ${key} was not kept`, error),
      SchemaError: (error) => Effect.logWarning(`the ${key} was not kept`, error),
    }),
    Effect.provide(BrowserKeyValueStore.layerLocalStorage),
  )
