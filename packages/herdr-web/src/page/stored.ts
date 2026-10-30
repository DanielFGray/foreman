// What this browser keeps for itself, in its local storage: a phone and a
// desk each keep their own.
import { BrowserKeyValueStore } from "@effect/platform-browser"
import { Effect, Option, type Schema } from "effect"
import { KeyValueStore } from "effect/persistence"

/** The kept value, or the fallback when there is none, it is from another version, or storage is closed to the page (a private window). */
export const loadStored = <S extends Schema.Constraint>(key: string, schema: S, fallback: S["Type"]) =>
  Effect.map(loadKept(key, schema), Option.getOrElse(() => fallback))

/** The kept value; none in the same cases as `loadStored`. */
export const loadKept = <S extends Schema.Constraint>(key: string, schema: S) =>
  Effect.gen(function* () {
    const store = KeyValueStore.toSchemaStore(yield* KeyValueStore.KeyValueStore, schema)
    return yield* store.get(key)
  }).pipe(
    Effect.catchTags({
      KeyValueStoreError: (error) => Effect.logWarning(`the kept ${key} cannot be read`, error).pipe(Effect.as(Option.none<S["Type"]>())),
      SchemaError: (error) => Effect.logWarning(`the kept ${key} is from another version`, error).pipe(Effect.as(Option.none<S["Type"]>())),
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

/** Forgets the kept value, so the next load gets its fallback; a failure is logged and dropped, as for `saveStored`. */
export const forgetStored = (key: string) =>
  Effect.gen(function* () {
    yield* (yield* KeyValueStore.KeyValueStore).remove(key)
  }).pipe(
    Effect.catchTag("KeyValueStoreError", (error) => Effect.logWarning(`the ${key} was not forgotten`, error)),
    Effect.provide(BrowserKeyValueStore.layerLocalStorage),
  )
