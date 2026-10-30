// The Worktrees page: the checkouts of the repository a space is in. It
// checks out a branch as a new space, opens a checkout, and removes a clean
// one after a second click. The bridge runs git on the space's machine.
import { Array, Option, String } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { Checkout } from "../shared/Worktree.ts"
import { FocusField, ListWorktrees, NewWorktree, OpenWorktree, RemoveWorktree, SaveSelection } from "./commands.ts"
import { CheckoutAction, CheckoutList, Message, type Model, Selection, type UpdateReturn, type WorktreeField, type WorktreePage } from "./model.ts"
import { lastFleet, selected } from "./selection.ts"

export const EMPTY_WORKTREE_PAGE: WorktreePage = { list: CheckoutList.Loading(), branch: "", program: "", action: CheckoutAction.Idle() }

/** Opens the page for the space and reads its checkouts; a branch typed earlier stays. */
export const openedWorktrees = (model: Model, space: string): UpdateReturn => {
  const next = selected(
    modifyFields(model, { isFleetFolded: () => true, worktreePage: (page) => ({ ...page, list: CheckoutList.Loading(), action: CheckoutAction.Idle() }) }),
    Selection.Worktrees({ space }),
  )
  return { model: next, commands: [SaveSelection({ selection: next.selection }), ListWorktrees({ space }), FocusField({ id: BRANCH_ID })] }
}

export const listedWorktrees = (model: Model, list: CheckoutList): Model => modifyFields(model, { worktreePage: (page) => ({ ...page, list }) })

export const editedWorktreeField = (model: Model, field: WorktreeField, value: string): Model =>
  modifyFields(model, { worktreePage: (page) => ({ ...page, [field]: value, action: CheckoutAction.Idle() }) })

/** Checks out the typed branch; nothing while another call is under way or no branch is typed. */
export const submittedWorktree = (model: Model): UpdateReturn => {
  const { branch, program, action } = model.worktreePage
  return Option.match(
    Option.filter(shownSpace(model), () => action._tag !== "Busy" && String.isNonEmpty(String.trim(branch))),
    {
      onNone: () => ({ model }),
      onSome: (space) => ({
        model: busy(model),
        commands: [NewWorktree({ space, branch: String.trim(branch), program: Option.filter(Option.some(String.trim(program)), String.isNonEmpty) })],
      }),
    },
  )
}

/** The first tab of the space that shows the checkout, when one does. */
export const checkoutTab = (model: Model, checkout: Checkout): Option.Option<string> => Option.flatMap(checkout.space, (space) => firstTabOf(model, space))

/** Opens a checkout no space shows as a new space. */
export const openedNewCheckout = (model: Model, checkout: Checkout): UpdateReturn =>
  Option.match(shownSpace(model), {
    onNone: () => ({ model }),
    onSome: (space) => ({ model: busy(model), commands: [OpenWorktree({ space, path: checkout.path })] }),
  })

export const confirmedRemoveCheckout = (model: Model, path: string): UpdateReturn =>
  Option.match(shownSpace(model), {
    onNone: () => ({ model }),
    onSome: (space) => ({ model: busy(model), commands: [RemoveWorktree({ space, path })] }),
  })

/** The checkout went: the list is read again. */
export const removedCheckout = (model: Model): UpdateReturn =>
  Option.match(shownSpace(model), {
    onNone: () => ({ model: withAction(model, CheckoutAction.Idle()) }),
    onSome: (space) => ({ model: withAction(model, CheckoutAction.Idle()), commands: [ListWorktrees({ space })] }),
  })

/** A new space opened for a checkout: the page shows its tab, and the form empties. */
export const openedCheckoutSpace = (model: Model, tab: string): Model =>
  selected(modifyFields(model, { worktreePage: () => EMPTY_WORKTREE_PAGE }), Selection.Tab({ tabId: tab, maybeFocus: Option.none() }))

export const withAction = (model: Model, action: CheckoutAction): Model => modifyFields(model, { worktreePage: (page) => ({ ...page, action }) })

/** The page: a form that checks out a branch, then every checkout with its buttons. */
export const worktreesView = (space: string, model: Model, h: HtmlBuilder<Message>): Html => {
  const { list, branch, program, action } = model.worktreePage
  const isBusy = action._tag === "Busy"
  const field = (label: string, key: WorktreeField, value: string, placeholder: string, more: ReadonlyArray<ReturnType<typeof h.Id>>) =>
    h.label(
      [h.Class("form-field")],
      [
        h.span([], [label]),
        h.input([
          h.Type("text"),
          h.Name(key),
          h.Value(value),
          h.Placeholder(placeholder),
          h.Spellcheck(false),
          h.Autocomplete("off"),
          h.OnInput((value) => Message.UpdatedWorktreeField({ field: key, value })),
          ...more,
        ]),
      ],
    )
  return h.section(
    [h.Class("workspace settings worktrees")],
    [
      h.h2([], [CheckoutList.match(list, { Loading: () => "Worktrees", Listed: ({ list }) => `Worktrees of ${list.repo}`, Unlisted: () => "Worktrees" })]),
      h.form(
        [h.Class("space-form worktree-form"), h.OnSubmit(Message.SubmittedWorktree())],
        [
          field("Branch", "branch", branch, "a new or existing branch", [h.Id(BRANCH_ID)]),
          field("Program", "program", program, "such as claude; empty: a shell", []),
          h.p([h.Class("note")], ["A new branch starts from this space's commit. The checkout goes in ~/.herdr/worktrees, where herdr-app puts its own."]),
          h.div([h.Class("form-actions")], [h.button([h.Type("submit"), h.Class("chip"), h.Disabled(isBusy || String.isEmpty(String.trim(branch)))], ["Check out"])]),
        ],
      ),
      ...CheckoutAction.match(action, {
        Idle: () => [],
        Confirming: () => [],
        Busy: () => [h.p([h.Class("note")], ["Asking git…"])],
        Refused: ({ reason }) => [h.p([h.Class("note error")], [reason])],
      }),
      ...CheckoutList.match(list, {
        Loading: () => [h.p([h.Class("note")], ["Reading the checkouts…"])],
        Unlisted: ({ reason }) => [h.p([h.Class("note error")], [`The checkouts cannot be read: ${reason}`])],
        Listed: ({ list }) => [h.ul([h.Class("checkouts"), h.AriaLabel("Checkouts")], Array.map(list.checkouts, (checkout) => checkoutView(checkout, space, action, h)))],
      }),
    ],
  )
}

const BRANCH_ID = "worktree-branch"

// The space this page is about. The page shows itself only while it is selected.
const shownSpace = (model: Model) => (model.selection._tag === "Worktrees" ? Option.some(model.selection.space) : Option.none())

const busy = (model: Model) => withAction(model, CheckoutAction.Busy())

const firstTabOf = (model: Model, space: string) =>
  Option.flatMap(lastFleet(model.bridge), ({ machines }) =>
    Option.flatMap(
      Array.findFirst(Array.flatMap(machines, ({ spaces }) => spaces), ({ id }) => id === space),
      ({ tabs }) => Option.map(Array.head(tabs), ({ id }) => id),
    ),
  )

const checkoutView = (checkout: Checkout, space: string, action: CheckoutAction, h: HtmlBuilder<Message>): Html => {
  const name = Option.getOrElse(checkout.branch, () => "detached head")
  const isBusy = action._tag === "Busy"
  const button = (text: string, title: string, message: Message) =>
    h.button([h.Type("button"), h.Class("chip"), h.Title(title), h.AriaLabel(title), h.Disabled(isBusy), h.OnClick(message)], [text])
  const isConfirming = action._tag === "Confirming" && action.path === checkout.path
  return h.keyed("li")(
    checkout.path,
    [h.Class(Option.contains(checkout.space, space) ? "checkout on" : "checkout")],
    [
      h.span([h.Class("checkout-branch")], [name, ...(checkout.isMain ? [h.span([h.Class("badge-word")], ["main checkout"])] : [])]),
      // The path is cut at its start, which the stylesheet does by writing it right to left; the marks keep its slashes in place.
      h.span([h.Class("checkout-path"), h.Title(checkout.path)], [`\u200E${checkout.path}\u200E`]),
      h.span(
        [h.Class("checkout-actions")],
        isConfirming
          ? [
              h.span([h.Class("note")], ["Removes the folder; the branch stays."]),
              button("remove it", `remove the checkout of ${name}`, Message.ConfirmedRemoveCheckout({ path: checkout.path })),
              button("keep", "keep the checkout", Message.ClickedKeepCheckout()),
            ]
          : [
              button(Option.isSome(checkout.space) ? "Show" : "Open", `open the checkout of ${name}`, Message.ClickedOpenCheckout({ checkout })),
              ...(checkout.isMain ? [] : [button("Remove", `remove the checkout of ${name}`, Message.ClickedRemoveCheckout({ path: checkout.path }))]),
            ],
      ),
    ],
  )
}
