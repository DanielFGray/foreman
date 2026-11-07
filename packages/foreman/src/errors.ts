/**
 * The tagged errors a verb can fail with. The UI contract sends them to the
 * page as they are, so this module holds only Schemas and no I/O.
 */
import { Schema as S } from "effect";

/** A refused pipeline or composite command: the detail is what the operator reads. */
export class PipelineError extends S.TaggedError<PipelineError>()("PipelineError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

export class PathsError extends S.TaggedError<PathsError>()("PathsError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

export class PromptError extends S.TaggedError<PromptError>()("PromptError", {
  template: S.String,
  detail: S.String,
}) {
  override get message() {
    return `${this.template}: ${this.detail}`;
  }
}

export class RegistryError extends S.TaggedError<RegistryError>()("RegistryError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

export class RewriteError extends S.TaggedError<RewriteError>()("RewriteError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}

export class RecordsError extends S.TaggedError<RecordsError>()("RecordsError", {
  command: S.String,
  detail: S.String,
}) {
  override get message() {
    return `${this.command}: ${this.detail}`;
  }
}

export class TrackerError extends S.TaggedError<TrackerError>()("TrackerError", {
  command: S.String,
  detail: S.String,
}) {
  override get message() {
    return `${this.command}: ${this.detail}`;
  }
}

export class FleetError extends S.TaggedError<FleetError>()("FleetError", {
  operation: S.String,
  detail: S.String,
}) {
  override get message() {
    return `${this.operation}: ${this.detail}`;
  }
}

/** Bun.build of the page failed; the UI server Layer stops, the dispatcher does not. */
export class PageBuildError extends S.TaggedError<PageBuildError>()("PageBuildError", {
  detail: S.String,
}) {
  override get message() {
    return this.detail;
  }
}
