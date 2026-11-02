// The Pipeline editor's updates. The saved pipeline and the draft are the
// model's; the problems are not, because they follow from the draft and the
// ladder's rungs (`problemsFor`), and a stored copy could go stale.
import { Option } from "effect"
import { problemsOf } from "foreman/pipeline"
import { ClearForemanPipeline, LoadForemanPipeline, SaveForemanPipeline } from "./commands.ts"
import { selectedProject, withPage } from "./foreman.ts"
import { type ForemanPage, type Model, PipelineView, type UpdateReturn } from "./model.ts"
import { applyEdit, type PipelineEdit } from "./pipelineEdit.ts"

type Editing = Extract<PipelineView, { _tag: "Editing" }>

/** The armed-button line of the reset, so the first click only arms it. */
export const RESET_LINE = "pipeline clear"

/**
 * Why the draft cannot run, or none while the ladder's rungs are unread: the
 * rungs decide which models are valid, so no answer is better than a wrong one.
 */
export const problemsFor = (page: ForemanPage, editing: Editing): Option.Option<ReadonlyArray<string>> =>
  page.rungs._tag === "Listed" ? Option.some(problemsOf(editing.draft, page.rungs.rungs)) : Option.none()

/** Opens the editor on the selected space's project, or reads it again. */
export const openedPipeline = (model: Model): UpdateReturn =>
  Option.match(selectedProject(model), {
    onNone: () => ({ model }),
    onSome: (project) => ({
      model: withPage(model, (page) => ({ ...page, pipeline: PipelineView.Loading({ project }), armed: Option.none() })),
      commands: [LoadForemanPipeline({ project })],
    }),
  })

export const closedPipeline = (model: Model): Model => withPage(model, (page) => ({ ...page, pipeline: PipelineView.Closed() }))

/** Foreman's reading replaces both the saved pipeline and the draft: a read follows a save, a reset or an open. */
export const receivedPipeline = (model: Model, project: string, drawn: boolean, pipeline: Editing["saved"]): Model =>
  withPage(model, (page) =>
    isAbout(page.pipeline, project)
      ? { ...page, pipeline: PipelineView.Editing({ project, drawn, saved: pipeline, draft: pipeline, selected: Option.none(), inserting: Option.none(), saving: false, refusal: Option.none() }) }
      : page,
  )

export const failedPipeline = (model: Model, project: string, reason: string): Model =>
  withPage(model, (page) =>
    isAbout(page.pipeline, project)
      ? { ...page, pipeline: page.pipeline._tag === "Editing" ? { ...page.pipeline, saving: false, refusal: Option.some(reason) } : PipelineView.Unlisted({ project, reason }) }
      : page,
  )

export const editedPipeline = (model: Model, edit: PipelineEdit): Model =>
  withEditing(model, (editing) => ({ ...editing, ...applyEdit(editing, edit), refusal: Option.none() }))

/** Sends the draft to foreman, unless it has problems or a save is under way. */
export const clickedSave = (model: Model): UpdateReturn => {
  const page = model.foremanPage
  if (page.pipeline._tag !== "Editing" || page.pipeline.saving) return { model }
  const { project, draft } = page.pipeline
  if (!Option.exists(problemsFor(page, page.pipeline), (problems) => problems.length === 0)) return { model }
  return {
    model: withEditing(model, (editing) => ({ ...editing, saving: true, refusal: Option.none() })),
    commands: [SaveForemanPipeline({ project, pipeline: draft })],
  }
}

export const clickedRevert = (model: Model): Model =>
  withEditing(model, (editing) => ({ ...editing, ...applyEdit({ ...editing, draft: editing.saved }, { _tag: "Select", id: editing.selected }), inserting: Option.none(), refusal: Option.none() }))

/** Drops the project's own pipeline. It discards the saved one, so it arms on the first click like the other commands that give something up. */
export const clickedReset = (model: Model): UpdateReturn => {
  const page = model.foremanPage
  if (page.pipeline._tag !== "Editing" || page.pipeline.saving) return { model }
  if (!Option.contains(page.armed, RESET_LINE)) return { model: withPage(model, (page) => ({ ...page, armed: Option.some(RESET_LINE) })) }
  const { project } = page.pipeline
  return {
    model: withPage(withEditing(model, (editing) => ({ ...editing, saving: true, refusal: Option.none() })), (page) => ({ ...page, armed: Option.none() })),
    commands: [ClearForemanPipeline({ project })],
  }
}

export const succeededChange = (model: Model, project: string): UpdateReturn => ({
  model,
  commands: isAbout(model.foremanPage.pipeline, project) ? [LoadForemanPipeline({ project })] : [],
})

export const failedChange = (model: Model, project: string, reason: string): Model =>
  withEditing(model, (editing) => (editing.project === project ? { ...editing, saving: false, refusal: Option.some(reason) } : editing))

const isAbout = (view: PipelineView, project: string): boolean => view._tag !== "Closed" && view.project === project

const withEditing = (model: Model, change: (editing: Editing) => Editing): Model =>
  withPage(model, (page) => (page.pipeline._tag === "Editing" ? { ...page, pipeline: change(page.pipeline) } : page))

