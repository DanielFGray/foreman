import { Schema as S } from "effect";

/** A refused pipeline or composite command: the detail is what the operator reads. */
export class PipelineError extends S.TaggedError<PipelineError>()("PipelineError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}
