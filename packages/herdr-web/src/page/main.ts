// The page: its start, how each message changes the model, what it watches,
// and the layout of sidebar, edge and workspace.
import { Array, Clock, Effect, Equivalence, Match, Option, Record, Schedule, Schema, Stream, String } from "effect"
import { Subscription } from "foldkit"
import * as Dom from "foldkit/dom"
import type { Document, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import { dropSide, hasFreshStatus, locate } from "./group.ts"
import { BridgeClient, failureReason } from "./rpc.ts"
import { fontStack, restyle, type Settings, stepSize } from "./settings.ts"
import { clampSidebarWidth, keyedSidebarWidth } from "./sidebarWidth.ts"
import { NO_MODIFIERS, withModifiers } from "./keys.ts"
import { usageBarView } from "./usage.ts"
import { FetchFonts, MoveSpace, PressKeys, RefreshUsage, SaveSelection, SaveSettings, SaveSidebarWidth, SplitPane, ClosePane, NewTab, CloseTab, FocusField, ListWorktrees, PickModel, SaveRecent } from "./commands.ts"
import { Asking, Bridge, CheckoutAction, CheckoutList, Conversation, Delivery, FontCatalog, KeySheet, LinkSheet, CommandList, Message, type Flags, type Model, Palette, PaneAction, Selection, SpaceDrag, type UpdateReturn, View } from "./model.ts"
import { lastFleet, maybeFocus, newView, openAs, selected, shownTerminals, supportsAt, tabAfterClosing, whenFocused, withView } from "./selection.ts"
import { confirmedCloseSpace, editedSpaceForm, EMPTY_SPACE_FORM, openedSpace, openedSpaceForm, refusedSpace, startedRename, submittedSpaceForm, submittedSpaceName, typedSpaceName } from "./spaces.ts"
import { checkoutTab, confirmedRemoveCheckout, editedWorktreeField, EMPTY_WORKTREE_PAGE, listedWorktrees, openedCheckoutSpace, openedNewCheckout, openedWorktrees, removedCheckout, submittedWorktree, withAction } from "./worktrees.ts"
import { listedCommands, pickedCommand, updatedPrompt } from "./slash.ts"
import { closedLinkSheet, copiedLink, notedLink, pointedAtLink } from "./linkSheet.ts"
import { CHOOSING_START, choosing, movedSoftKey, pinnedSheetKey, removedSoftKey, restoredSoftKeys, sentSheetKey, withSheet } from "./keySheet.ts"
import { SECONDS_SHOWN_UNTIL } from "./status.ts"
import { shownSidebarWidth, sidebarEdgeView, sidebarView } from "./sidebar.ts"
import { delivered, dropped, held, queued, reconsidered, sentNow, watchedBoxes } from "./queue.ts"
import { boxRead, emptied, failedWrite, paused, pendingEdit, promptOf, submitted, wrote } from "./mirror.ts"
import { clocked, settled } from "./waiting.ts"
import { isPaletteKey, PALETTE_INPUT_ID, PaletteTarget, withRecent } from "./palette.ts"
import { answered, chose, QuestionRead, questionReads, readQuestion, typedAnswer } from "./question.ts"
import { paletteResults, paletteView } from "./paletteView.ts"
import { topBarView, workspaceView } from "./workspace.ts"

// CONSTANT

const RECONNECT_DELAY = "2 seconds"
/** Reset countdowns count in minutes. */
const CLOCK_TICK = "30 seconds"
/** While a prompt waits, or an agent changed state under a minute ago, so their clocks show on time. */
const FAST_CLOCK_TICK = "1 second"
/** How long typing in a prompt pauses before the prompt goes into the agent's input box. */
const TYPING_PAUSE = "500 millis"

// INIT

export const init = ({ settings, selection, sidebarWidth, recent, softKeys }: Flags): UpdateReturn => ({
  model: {
    bridge: Bridge.Waiting(),
    // A page that opens on a remembered tab shows it at once, on a phone too.
    isFleetFolded: selection._tag !== "Nothing",
    selection,
    views: {},
    prompts: {},
    delivery: Delivery.Ready(),
    queued: [],
    boxes: {},
    models: {},
    viewport: Option.none(),
    waiting: [],
    questions: {},
    paneAction: PaneAction.Idle(),
    spaceDrag: SpaceDrag.Idle(),
    spaceForm: EMPTY_SPACE_FORM,
    worktreePage: EMPTY_WORKTREE_PAGE,
    palette: Palette.Closed(),
    recent,
    settings,
    modifiers: NO_MODIFIERS,
    softKeys,
    keySheet: KeySheet.Closed(),
    linkSheet: LinkSheet.Closed(),
    commandList: CommandList.Unread(),
    fontCatalog: FontCatalog.Loading(),
    usage: Option.none(),
    usageDetail: Option.none(),
    now: 0,
    sidebarWidth,
    sidebarGrip: Option.none(),
  },
  commands: Selection.match(selection, {
    Nothing: () => [],
    Tab: () => [],
    Loose: () => [],
    Settings: () => [FetchFonts()],
    NewSpace: () => [],
    Worktrees: ({ space }) => [ListWorktrees({ space })],
  }),
})

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ReceivedFleet: ({ fleet }) => reconsidered(model, modifyFields(model, { bridge: () => Bridge.Watching({ fleet }) })),

    LostBridge: () => reconsidered(model, modifyFields(model, { bridge: () => Bridge.Lost({ maybeFleet: lastFleet(model.bridge) }) })),

    ClickedFleetToggle: () => ({ model: modifyFields(model, { isFleetFolded: (isFolded) => !isFolded }) }),

    ClickedTerminal: ({ address }) =>
      remembered(
        selected(
          modifyFields(model, { isFleetFolded: () => true }),
          Option.match(Option.flatMap(lastFleet(model.bridge), (fleet) => locate(fleet, address)), {
            onNone: () => Selection.Loose({ address }),
            onSome: ({ tab }) => Selection.Tab({ tabId: tab.id, maybeFocus: Option.some(address) }),
          }),
        ),
      ),

    ClickedTab: ({ tabId }) =>
      remembered(selected(modifyFields(model, { isFleetFolded: () => true }), Selection.Tab({ tabId, maybeFocus: Option.none() }))),

    // The pane head carries the close button, so a focus keeps a close waiting for its second click.
    FocusedPane: ({ address }) =>
      Selection.match<UpdateReturn>(model.selection, {
        Nothing: () => ({ model }),
        // The tab and its views stay; only the prompt's last reply was for the old focus.
        Tab: ({ tabId, maybeFocus }) =>
          Option.contains(maybeFocus, address)
            ? { model }
            : remembered(
                modifyFields(model, {
                  selection: () => Selection.Tab({ tabId, maybeFocus: Option.some(address) }),
                  delivery: () => Delivery.Ready(),
                }),
              ),
        Loose: () => ({ model }),
        Settings: () => ({ model }),
        NewSpace: () => ({ model }),
        Worktrees: () => ({ model }),
      }),

    // A terminal view attaches when its pane appears, and lets go when it leaves.
    SelectedView: ({ address, view }) => ({ model: withView(model, address, () => newView(view)) }),

    ReceivedChat: ({ address, update }) => ({
      model: settled(
        withView(model, address, (view) =>
          withConversation(view, (conversation) =>
            Conversation.Shown({
              entries: Match.valueTags(update, {
                Reset: ({ entries }) => entries,
                Appended: ({ entries }) => Array.appendAll(shownEntries(conversation), entries),
              }),
            }),
          ),
        ),
      ),
    }),

    FailedChat: ({ address, reason }) => ({
      model: withView(model, address, (view) => withConversation(view, () => Conversation.Unreadable({ reason }))),
    }),

    ReceivedQuestion: ({ address, statusMs, question }) => ({
      model: readQuestion(
        model,
        address,
        statusMs,
        Option.match(question, {
          onNone: () => Asking.Unshown({ reason: Option.none() }),
          onSome: (shown) => Asking.Shown({ question: shown, sending: Option.none() }),
        }),
      ),
    }),

    FailedQuestion: ({ address, statusMs, reason }) => ({
      model: readQuestion(model, address, statusMs, Asking.Unshown({ reason: Option.some(reason) })),
    }),

    ClickedChoice: ({ address, choice }) => chose(model, address, { _tag: "Picked", choice }),

    SucceededAnswer: ({ address }) => ({ model: answered(model, address, Option.none()) }),

    FailedAnswer: ({ address, reason }) => ({ model: answered(model, address, Option.some(reason)) }),

    ChangedLink: ({ address, link }) => ({
      model: withView(model, address, (view) => View.match(view, { Chat: () => view, Terminal: () => View.Terminal({ link }) })),
    }),

    ClickedSplit: ({ pane, direction }) => ({
      model: modifyFields(model, { paneAction: () => PaneAction.Idle() }),
      commands: [SplitPane({ pane, direction })],
    }),

    // The new shell takes the focus once the fleet shows it in the tab.
    SucceededSplit: ({ terminal }) =>
      Selection.match<UpdateReturn>(model.selection, {
        Nothing: () => ({ model }),
        Tab: ({ tabId }) => remembered(modifyFields(model, { selection: () => Selection.Tab({ tabId, maybeFocus: Option.some(terminal) }) })),
        Loose: () => ({ model }),
        Settings: () => ({ model }),
        NewSpace: () => ({ model }),
        Worktrees: () => ({ model }),
      }),

    // Closing a pane ends its program, so it takes a second click.
    ClickedClose: ({ pane }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.Confirming({ pane }) }) }),

    ClickedKeepPane: () => ({ model: modifyFields(model, { paneAction: () => PaneAction.Idle() }) }),

    ConfirmedClose: ({ pane }) => ({
      model: modifyFields(model, { paneAction: () => PaneAction.Idle() }),
      commands: [ClosePane({ pane })],
    }),

    SucceededClose: () => ({ model }),

    ClickedNewTab: ({ space }) => ({
      model: modifyFields(model, { paneAction: () => PaneAction.Idle() }),
      commands: [NewTab({ space })],
    }),

    // The new tab shows once the fleet lists it.
    SucceededNewTab: ({ tab }) => remembered(selected(model, Selection.Tab({ tabId: tab, maybeFocus: Option.none() }))),

    // Closing a tab ends its programs, so it takes a second click like a pane.
    ClickedCloseTab: ({ tab }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.ConfirmingTab({ tab }) }) }),

    // Closing the tab on show moves to its neighbour at once, not to a page that says it is gone.
    ConfirmedCloseTab: ({ tab }) => {
      const idle = modifyFields(model, { paneAction: () => PaneAction.Idle() })
      return Option.match(tabAfterClosing(model, tab), {
        onNone: () => ({ model: idle, commands: [CloseTab({ tab })] }),
        onSome: (next) => {
          const moved = selected(idle, Selection.Tab({ tabId: next.id, maybeFocus: Option.none() }))
          return { model: moved, commands: [CloseTab({ tab }), SaveSelection({ selection: moved.selection })] }
        },
      })
    },

    SucceededCloseTab: () => ({ model }),

    FailedPaneAction: ({ reason }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.Refused({ reason }) }) }),

    ClickedCloseSpace: ({ space }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.ConfirmingSpace({ space }) }) }),

    ConfirmedCloseSpace: ({ space }) => confirmedCloseSpace(model, space),

    ClickedRenameSpace: ({ space }) => startedRename(model, space),

    UpdatedSpaceName: ({ name }) => ({ model: typedSpaceName(model, name) }),

    SubmittedSpaceName: () => submittedSpaceName(model),

    SucceededSpaceChange: () => ({ model }),

    // On a phone the form opens behind the sidebar drawer, so it closes as a picked tab closes it.
    ClickedNewSpace: () => (model.selection._tag === "NewSpace" ? { model: modifyFields(model, { isFleetFolded: () => true }) } : openedSpaceForm(model)),

    UpdatedSpaceForm: ({ field, value }) => ({ model: editedSpaceForm(model, field, value) }),

    SubmittedSpaceForm: () => submittedSpaceForm(model),

    SucceededNewSpace: ({ tab }) => remembered(openedSpace(model, tab)),

    FailedNewSpace: ({ reason }) => ({ model: refusedSpace(model, reason) }),

    ClickedWorktrees: ({ space }) => openedWorktrees(model, space),

    ReceivedWorktrees: ({ list }) => ({ model: listedWorktrees(model, CheckoutList.Listed({ list })) }),

    FailedWorktrees: ({ reason }) => ({ model: listedWorktrees(model, CheckoutList.Unlisted({ reason })) }),

    UpdatedWorktreeField: ({ field, value }) => ({ model: editedWorktreeField(model, field, value) }),

    SubmittedWorktree: () => submittedWorktree(model),

    ClickedOpenCheckout: ({ checkout }) =>
      Option.match(checkoutTab(model, checkout), {
        onSome: (tabId) => update(model, Message.ClickedTab({ tabId })),
        onNone: () => openedNewCheckout(model, checkout),
      }),

    ClickedRemoveCheckout: ({ path }) => ({ model: withAction(model, CheckoutAction.Confirming({ path })) }),

    ClickedKeepCheckout: () => ({ model: withAction(model, CheckoutAction.Idle()) }),

    ConfirmedRemoveCheckout: ({ path }) => confirmedRemoveCheckout(model, path),

    SucceededRemoveCheckout: () => removedCheckout(model),

    SucceededCheckoutSpace: ({ tab }) => remembered(openedCheckoutSpace(model, tab)),

    FailedCheckoutAction: ({ reason }) => ({ model: withAction(model, CheckoutAction.Refused({ reason })) }),

    // A press while a move is under way waits for the fleet's new order.
    PressedSpace: ({ space }) =>
      model.spaceDrag._tag === "Moving"
        ? { model }
        : { model: modifyFields(model, { spaceDrag: () => SpaceDrag.Pressed({ space, over: Option.none() }) }) },

    EnteredSpace: ({ space: over }) =>
      SpaceDrag.match<UpdateReturn>(model.spaceDrag, {
        Idle: () => ({ model }),
        Pressed: ({ space }) => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Pressed({ space, over: Option.some(over) }) }) }),
        Moving: () => ({ model }),
        Refused: () => ({ model }),
      }),

    // A release on the pressed row is a click, which opens the space.
    ReleasedSpace: ({ space: onto }) =>
      SpaceDrag.match<UpdateReturn>(model.spaceDrag, {
        Idle: () => ({ model }),
        Pressed: ({ space }) =>
          Option.match(Option.flatMap(lastFleet(model.bridge), (fleet) => dropSide(fleet, space, onto)), {
            onNone: () => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Idle() }) }),
            onSome: () => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Moving() }), commands: [MoveSpace({ space, onto })] }),
          }),
        Moving: () => ({ model }),
        Refused: () => ({ model }),
      }),

    DroppedSpaceDrag: () =>
      model.spaceDrag._tag === "Pressed" ? { model: modifyFields(model, { spaceDrag: () => SpaceDrag.Idle() }) } : { model },

    SucceededMoveSpace: () => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Idle() }) }),

    FailedMoveSpace: ({ reason }) => ({ model: modifyFields(model, { spaceDrag: () => SpaceDrag.Refused({ reason }) }) }),

    // On a phone the settings open behind the sidebar drawer, so it closes as a picked tab closes it.
    ClickedSettings: () =>
      model.selection._tag === "Settings"
        ? { model: modifyFields(model, { isFleetFolded: () => true }) }
        : openSettings(model),

    PickedFont: ({ surface, font }) => settingsChanged(model, restyle(model.settings, surface, (style) => ({ ...style, font }))),

    SteppedSize: ({ surface, step }) => settingsChanged(model, restyle(model.settings, surface, (style) => stepSize(style, step))),

    PickedAgentList: ({ agents }) => settingsChanged(model, { ...model.settings, agents }),
    CompletedSaveSettings: () => ({ model }),

    CompletedSaveSelection: () => ({ model }),

    ReceivedFonts: ({ families }) => ({ model: modifyFields(model, { fontCatalog: () => FontCatalog.Loaded({ families }) }) }),

    FailedFonts: ({ reason }) => ({ model: modifyFields(model, { fontCatalog: () => FontCatalog.Failed({ reason }) }) }),

    UpdatedPrompt: ({ text }) => Option.match(maybeFocus(model), { onNone: () => ({ model }), onSome: (address) => updatedPrompt(model, address, text) }),

    PausedTyping: ({ address, text }) => paused(model, address, text),

    WroteInputBox: ({ address, text, box }) => reconsidered(model, wrote(model, address, text, box)),

    FailedWriteInputBox: ({ address, reason }) => ({ model: failedWrite(model, address, reason) }),

    ReceivedCommands: ({ address, commands }) => ({ model: listedCommands(model, address, CommandList.Listed({ address, commands })) }),

    FailedCommands: ({ address, reason }) => ({ model: listedCommands(model, address, CommandList.Unlisted({ address, reason })) }),

    PickedCommand: ({ name }) => ({ model: Option.match(maybeFocus(model), { onNone: () => model, onSome: (address) => pickedCommand(model, address, name) }) }),

    SubmittedPrompt: () =>
      Option.match(maybeFocus(model), {
        onNone: () => ({ model }),
        onSome: (address) => {
          const { text } = promptOf(model, address)
          return String.isEmpty(String.trim(text))
            ? { model }
            : Option.match(typedAnswer(model, address, text), {
                // While the agent waits on a question, the prompt answers it.
                onSome: (answer) => chose(submitted(model, address), address, answer),
                onNone: () => queued(submitted(model, address), address, text),
              })
        },
      }),

    SucceededSendPrompt: ({ address, id }) => delivered(emptied(model, address), address, id),

    FailedSendPrompt: ({ address, id, reason }) => ({ model: held(model, address, id, reason) }),

    ClickedSendNow: ({ address, id }) => sentNow(model, address, id),

    ClickedDropQueued: ({ address, id }) => ({ model: dropped(model, address, id) }),

    ReceivedInputBox: ({ address, box }) => reconsidered(model, boxRead(modifyFields(model, { boxes: (all) => Record.set(all, address, box) }), address, box)),

    // Unread, the box may hold a draft, so the agent's messages wait until it is read again.
    FailedInputBox: ({ address }) => ({ model: modifyFields(model, { boxes: (all) => Record.remove(all, address) }) }),

    ReceivedModel: ({ address, model: name }) => ({
      model: modifyFields(model, { models: (all) => Option.match(name, { onNone: () => Record.remove(all, address), onSome: (one) => Record.set(all, address, one) }) }),
    }),

    // A second click on the tag closes its menu.
    ClickedModelTag: ({ address }) => ({
      model: modifyFields(model, {
        paneAction: (action) => (action._tag === "PickingModel" && action.address === address ? PaneAction.Idle() : PaneAction.PickingModel({ address })),
      }),
    }),

    PickedModel: ({ address, alias }) => ({ model: modifyFields(model, { paneAction: () => PaneAction.Idle() }), commands: [PickModel({ address, alias })] }),

    SucceededPickModel: () => ({ model }),

    ChangedViewport: ({ viewport }) => ({ model: modifyFields(model, { viewport: () => viewport }) }),

    ClickedKey: ({ key }) =>
      Option.match(maybeFocus(model), {
        onNone: () => ({ model }),
        onSome: (address) => ({
          model: modifyFields(model, { modifiers: () => NO_MODIFIERS }),
          commands: [PressKeys({ address, keys: [withModifiers(key, model.modifiers)] })],
        }),
      }),

    ToggledModifier: ({ modifier }) =>
      ({ model: modifyFields(model, { modifiers: (armed) => ({ ...armed, [modifier]: !armed[modifier] }) }) }),

    ClickedSendKeys: () => ({ model: withSheet(model, () => CHOOSING_START) }),

    ClosedKeySheet: () => ({ model: withSheet(model, () => KeySheet.Closed()) }),

    PickedKeyGroup: ({ group }) => ({ model: choosing(model, (sheet) => ({ ...sheet, group })) }),

    PickedSheetKey: ({ key }) => ({ model: choosing(model, (sheet) => ({ ...sheet, named: key })) }),

    TypedSheetCharacter: ({ text }) => ({ model: choosing(model, (sheet) => ({ ...sheet, typed: text })) }),

    ToggledSheetModifier: ({ modifier }) =>
      ({ model: choosing(model, (sheet) => ({ ...sheet, modifiers: { ...sheet.modifiers, [modifier]: !sheet.modifiers[modifier] } })) }),

    ClickedSendSheetKey: () => sentSheetKey(model),

    ClickedPinSheetKey: () => pinnedSheetKey(model),

    ClickedEditSoftKeys: () => ({ model: withSheet(model, () => KeySheet.Editing()) }),

    MovedSoftKey: ({ index, by }) => movedSoftKey(model, index, by),

    RemovedSoftKey: ({ index }) => removedSoftKey(model, index),

    ClickedRestoreSoftKeys: () => restoredSoftKeys(model),

    CompletedSaveSoftKeys: () => ({ model }),

    PointedAtLink: ({ uri }) => ({ model: pointedAtLink(model, uri) }),

    ClosedLinkSheet: () => ({ model: closedLinkSheet(model) }),

    ClickedCopyLink: () => copiedLink(model),

    CopiedLink: () => ({ model: notedLink(model, "Copied.") }),

    FailedCopyLink: ({ reason }) => ({ model: notedLink(model, `Not copied: ${reason}`) }),

    UsedModifiers: () => ({ model: modifyFields(model, { modifiers: () => NO_MODIFIERS }) }),

    CompletedKeepTypingFocus: () => ({ model }),

    SucceededPressKeys: ({ address }) =>
      whenFocused(model, address, () => ({ model: modifyFields(model, { delivery: () => Delivery.Ready() }) })),

    FailedPressKeys: ({ address, reason }) =>
      whenFocused(model, address, () => ({ model: modifyFields(model, { delivery: () => Delivery.Refused({ reason }) }) })),

    ReceivedUsage: ({ usage }) => ({ model: modifyFields(model, { usage: () => Option.some(usage) }) }),

    ToggledUsageDetail: ({ provider }) => ({
      model: modifyFields(model, {
        usageDetail: (open) => (Option.contains(open, provider) ? Option.none() : Option.some(provider)),
      }),
    }),

    ClickedRefreshUsage: ({ provider }) => ({ model, commands: [RefreshUsage({ provider })] }),

    CompletedRefreshUsage: () => ({ model }),

    TickedClock: ({ now }) => ({ model: clocked(modifyFields(model, { now: () => now })) }),

    // The sidebar starts at the page's left edge, so its width is where the pointer is, less its grip.
    PressedSidebarEdge: ({ x }) => ({ model: modifyFields(model, { sidebarGrip: () => Option.some(x - shownSidebarWidth(model)) }) }),

    MovedSidebarEdge: ({ x }) =>
      Option.match(model.sidebarGrip, {
        onNone: () => ({ model }),
        onSome: (grip) => ({ model: modifyFields(model, { sidebarWidth: () => Option.some(clampSidebarWidth(x - grip)) }) }),
      }),

    // The width is kept once, when the edge is let go.
    ReleasedSidebarEdge: () => ({
      model: modifyFields(model, { sidebarGrip: () => Option.none() }),
      commands: [SaveSidebarWidth({ width: model.sidebarWidth })],
    }),

    KeyedSidebarEdge: ({ key }) =>
      Option.match(keyedSidebarWidth(shownSidebarWidth(model), key), {
        onNone: () => ({ model }),
        onSome: (width) => ({
          model: modifyFields(model, { sidebarWidth: () => Option.some(width) }),
          commands: [SaveSidebarWidth({ width: Option.some(width) })],
        }),
      }),

    ResetSidebarWidth: () => ({
      model: modifyFields(model, { sidebarWidth: () => Option.none() }),
      commands: [SaveSidebarWidth({ width: Option.none() })],
    }),

    CompletedSaveSidebarWidth: () => ({ model }),

    PressedPaletteKey: () =>
      Palette.match<UpdateReturn>(model.palette, {
        Closed: () => ({ model: modifyFields(model, { palette: () => Palette.Open({ query: "", highlighted: 0 }) }), commands: [FocusField({ id: PALETTE_INPUT_ID })] }),
        Open: () => ({ model: closedPalette(model) }),
      }),

    ClosedPalette: () => ({ model: closedPalette(model) }),

    // A new query starts again from its best match.
    UpdatedPaletteQuery: ({ text }) =>
      model.palette._tag === "Open" ? { model: modifyFields(model, { palette: () => Palette.Open({ query: text, highlighted: 0 }) }) } : { model },

    // The highlight wraps from the last result to the first and back.
    MovedPaletteHighlight: ({ step }) => {
      const count = paletteResults(model).length
      return Palette.match<UpdateReturn>(model.palette, {
        Closed: () => ({ model }),
        Open: ({ query, highlighted }) =>
          count > 0 ? { model: modifyFields(model, { palette: () => Palette.Open({ query, highlighted: (highlighted + step + count) % count }) }) } : { model },
      })
    },

    OpenedPaletteResult: ({ target }) => openedTarget(closedPalette(model), target),

    SubmittedPalette: () =>
      Palette.match<UpdateReturn>(model.palette, {
        Closed: () => ({ model }),
        Open: ({ highlighted }) =>
          Option.match(Array.get(paletteResults(model), highlighted), {
            onNone: () => ({ model }),
            onSome: ({ target }) => openedTarget(closedPalette(model), target),
          }),
      }),

    CompletedFocusField: () => ({ model }),

    CompletedSaveRecent: () => ({ model }),
  })

const closedPalette = (model: Model) => modifyFields(model, { palette: () => Palette.Closed() })

/** A palette result opens what the same row in the sidebar opens. */
const openedTarget = (model: Model, target: PaletteTarget): UpdateReturn =>
  PaletteTarget.match(target, {
    Tab: ({ tabId }) => update(model, Message.ClickedTab({ tabId })),
    Terminal: ({ address }) => update(model, Message.ClickedTerminal({ address })),
    Settings: () => update(model, Message.ClickedSettings()),
  })

const withConversation = (view: View, change: (conversation: Conversation) => Conversation) =>
  View.match(view, { Chat: ({ conversation }) => View.Chat({ conversation: change(conversation) }), Terminal: () => view })

const shownEntries = (conversation: Conversation) =>
  Conversation.match(conversation, { Loading: () => [], Shown: ({ entries }) => entries, Unreadable: () => [] })

// The settings in use are already in the model, so a save that fails costs
// only the next visit's settings; it is logged, not shown.
const settingsChanged = (model: Model, settings: Settings) => ({
  model: modifyFields(model, { settings: () => settings }),
  commands: [SaveSettings({ settings })],
})

/** Shows the settings in place of the tab, and asks the bridge for its fonts again. */
const openSettings = (model: Model): UpdateReturn => {
  const next = selected(modifyFields(model, { isFleetFolded: () => true, fontCatalog: () => FontCatalog.Loading() }), Selection.Settings())
  return { model: next, commands: [SaveSelection({ selection: next.selection }), FetchFonts()] }
}

/** Keeps the tab and pane on show, so a reload opens on them, and the pane among the recent ones. */
const remembered = (model: Model): UpdateReturn => {
  const recent = Option.match(maybeFocus(model), { onNone: () => model.recent, onSome: (address) => withRecent(model.recent, address) })
  return {
    model: modifyFields(model, { recent: () => recent }),
    commands: [SaveSelection({ selection: model.selection }), ...(Array.makeEquivalence(Equivalence.strictEqual<string>())(recent, model.recent) ? [] : [SaveRecent({ recent })])],
  }
}

// SUBSCRIPTION

// Foldkit restarts an entry's stream whenever its dependencies change. The
// chat entry depends on which shown terminals show their chat, not on the
// focus, so moving the focus leaves every chat running. A live terminal is
// not a subscription: its pane holds it (see LiveTerminal).
export const subscriptions = Subscription.make<Model, Message, BridgeClient>()((entry) => ({
  // The fleet for the whole life of the page. When the watch ends or fails,
  // the page says so and watches again after a pause.
  fleet: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Effect.gen(function* () {
          const client = yield* BridgeClient
          return client.watch().pipe(
            Stream.map((fleet) => Message.ReceivedFleet({ fleet })),
            Stream.tapCause((cause) => Effect.logWarning("the bridge's fleet watch failed", cause)),
            Stream.catchCause(() => Stream.empty),
            Stream.concat(Stream.make(Message.LostBridge())),
          )
        }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY))),
    },
  ),

  // The usage of each coding plan, for the life of the page, as the fleet.
  usage: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Effect.gen(function* () {
          const client = yield* BridgeClient
          return client.usage().pipe(
            Stream.map((usage) => Message.ReceivedUsage({ usage })),
            Stream.tapCause((cause) => Effect.logWarning("the bridge's usage watch failed", cause)),
            Stream.catchCause(() => Stream.empty),
          )
        }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY))),
    },
  ),

  // Ctrl+K anywhere on the page, a focused terminal included: the listener runs
  // first (capture) and stops the key there, so it is never typed into the
  // terminal, and the browser does not take it for its own.
  palette: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Dom.streamFromEventFilterMapPreventDefault({
          target: () => window,
          type: "keydown",
          options: { capture: true },
          filterMapEvent: (event) => {
            if (!isPaletteKey(event)) return Option.none()
            event.stopPropagation()
            return Option.some(Message.PressedPaletteKey())
          },
        }),
    },
  ),

  // The visible part of the window, now and after each change. A browser
  // without visualViewport reports nothing, and the page fills the window.
  viewport: entry(
    {},
    {
      modelToDependencies: () => ({}),
      dependenciesToStream: () =>
        Option.match(Option.fromNullishOr(window.visualViewport), {
          onNone: () => Stream.empty,
          onSome: (visible) => {
            const read = () => Message.ChangedViewport({ viewport: viewportOf(visible) })
            return Stream.concat(
              Stream.sync(read),
              Stream.merge(
                Dom.streamFromEvent({ target: visible, type: "resize", mapEvent: read }),
                Dom.streamFromEvent({ target: visible, type: "scroll", mapEvent: read }),
              ),
            )
          },
        }),
    },
  ),

  // The pointer anywhere on the page while the sidebar's edge is held, since
  // a drag soon leaves the thin edge behind.
  sidebarDrag: entry(
    { isHeld: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isHeld: Option.isSome(model.sidebarGrip) }),
      dependenciesToStream: ({ isHeld }) =>
        isHeld
          ? Stream.merge(
              Dom.streamFromEvent({ target: () => window, type: "pointermove", mapEvent: ({ clientX }) => Message.MovedSidebarEdge({ x: clientX }) }),
              Dom.streamFromEvent({ target: () => window, type: "pointerup", mapEvent: () => Message.ReleasedSidebarEdge() }),
            )
          : Stream.empty,
    },
  ),

  // Faster while a prompt waits or an agent shows seconds. A new rate starts a new stream, which reads
  // the clock at once, so a prompt just sent learns its time straight away.
  clock: entry(
    { isFast: Schema.Boolean },
    {
      modelToDependencies: (model) => ({
        isFast:
          Array.isReadonlyArrayNonEmpty(model.waiting) || Option.exists(lastFleet(model.bridge), (fleet) => hasFreshStatus(fleet, model.now, SECONDS_SHOWN_UNTIL)),
      }),
      dependenciesToStream: ({ isFast }) =>
        Stream.fromEffectSchedule(Clock.currentTimeMillis, Schedule.spaced(isFast ? FAST_CLOCK_TICK : CLOCK_TICK)).pipe(
          Stream.map((now) => Message.TickedClock({ now })),
        ),
    },
  ),

  // The question each blocked agent in a shown chat waits on. A new block, or
  // an answer, changes the reads and so reads the screens again.
  questions: entry(
    { reads: Schema.Array(QuestionRead) },
    {
      modelToDependencies: (model) => ({ reads: questionReads(model) }),
      dependenciesToStream: ({ reads }) => Stream.mergeAll(Array.map(reads, questionStream), { concurrency: "unbounded" }),
    },
  ),

  // The input box of each agent in a shown chat or with messages queued, which
  // tells the queue when the agent can take a message and the prompt what it suggests.
  inputBoxes: entry(
    { addresses: Schema.Array(Schema.String) },
    {
      modelToDependencies: (model) => ({ addresses: Array.filter(watchedBoxes(model, openAs(model, "Chat")), (address) => supportsAt(model, address, "inputBox")) }),
      dependenciesToStream: ({ addresses }) => Stream.mergeAll(Array.map(addresses, inputBoxStream), { concurrency: "unbounded" }),
    },
  ),

  // A pause in typing in the focused prompt: each edit starts the wait again.
  typingPause: entry(
    { edit: Schema.Option(Schema.Struct({ address: Schema.String, text: Schema.String })) },
    {
      modelToDependencies: (model) => ({ edit: pendingEdit(model) }),
      dependenciesToStream: ({ edit }) =>
        Option.match(edit, {
          onNone: () => Stream.empty,
          onSome: ({ address, text }) => Stream.fromEffect(Effect.as(Effect.sleep(TYPING_PAUSE), Message.PausedTyping({ address, text }))),
        }),
    },
  ),

  // The model of each shown agent that names one. A failed read shows no tag, and
  // is tried again after a pause.
  models: entry(
    { addresses: Schema.Array(Schema.String) },
    {
      modelToDependencies: (model) => ({ addresses: Array.filter(shownTerminals(model), (address) => supportsAt(model, address, "model")) }),
      dependenciesToStream: ({ addresses }) => Stream.mergeAll(Array.map(addresses, modelStream), { concurrency: "unbounded" }),
    },
  ),

  // Each shown chat, live. When a call fails the page shows why and calls
  // again after a pause; the bridge then sends the whole recent chat again.
  chat: entry(
    { addresses: Schema.Array(Schema.String) },
    {
      modelToDependencies: (model) => ({ addresses: openAs(model, "Chat") }),
      dependenciesToStream: ({ addresses }) => Stream.mergeAll(Array.map(addresses, chatStream), { concurrency: "unbounded" }),
    },
  ),
}))

const questionStream = ({ address, statusMs }: QuestionRead) =>
  Stream.fromEffect(
    Effect.gen(function* () {
      const client = yield* BridgeClient
      const question = yield* client.question({ terminal: address })
      return Message.ReceivedQuestion({ address, statusMs, question })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedQuestion({ address, statusMs, reason: failureReason(error) })))),
  )

const inputBoxStream = (address: string) =>
  Effect.gen(function* () {
    const client = yield* BridgeClient
    return client.inputBox({ terminal: address }).pipe(
      Stream.map((box) => Message.ReceivedInputBox({ address, box })),
      Stream.tapCause((cause) => Effect.logWarning("the bridge's input box watch failed", cause)),
      Stream.catchCause(() => Stream.make(Message.FailedInputBox({ address }))),
    )
  }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY)))

// A zoomed page shows part of itself on purpose; fitting the page to that part
// would undo the zoom. The keyboard leaves the scale at 1.
const viewportOf = (visible: VisualViewport) =>
  visible.scale === 1 ? Option.some({ top: visible.offsetTop, height: visible.height }) : Option.none()

const modelStream = (address: string) =>
  Effect.gen(function* () {
    const client = yield* BridgeClient
    return client.model({ terminal: address }).pipe(
      Stream.map((model) => Message.ReceivedModel({ address, model })),
      Stream.tapCause((cause) => Effect.logWarning("the bridge's model watch failed", cause)),
      Stream.catchCause(() => Stream.make(Message.ReceivedModel({ address, model: Option.none() }))),
    )
  }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY)))

const chatStream = (address: string) =>
  Effect.gen(function* () {
    const client = yield* BridgeClient
    return client.chat({ terminal: address }).pipe(
      Stream.map((update) => Message.ReceivedChat({ address, update })),
      Stream.catch((error) => Stream.make(Message.FailedChat({ address, reason: failureReason(error) }))),
    )
  }).pipe(Stream.unwrap, Stream.repeat(Schedule.spaced(RECONNECT_DELAY)))

// VIEW

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "herdr-web",
  body: h.div(
    [
      h.Class(Option.isSome(model.sidebarGrip) ? "app resizing" : "app"),
      h.Style({
        "--chat-font": fontStack("chat", model.settings.chat.font),
        "--chat-size": `${model.settings.chat.size}px`,
        "--sidebar-width": `${shownSidebarWidth(model)}px`,
        // The page fills what a person sees, so a phone's keyboard pushes the prompt up instead of covering it.
        "--viewport-top": `${Option.match(model.viewport, { onNone: () => 0, onSome: ({ top }) => top })}px`,
        "--viewport-height": Option.match(model.viewport, { onNone: () => "100dvh", onSome: ({ height }) => `${height}px` }),
      }),
    ],
    [
      sidebarView(model, h),
      sidebarEdgeView(model, h),
      ...paletteView(model, h),
      // On a phone the sidebar is a drawer over the page; a tap beside it closes it.
      ...(model.isFleetFolded ? [] : [h.div([h.Class("fleet-backdrop"), h.OnClick(Message.ClickedFleetToggle())], [])]),
      h.main(
        [h.Class("main")],
        [
          topBarView(model, h),
          workspaceView(model, h),
          ...usageBarView(
            model.usage,
            model.usageDetail,
            model.now,
            {
              toggled: (provider) => Message.ToggledUsageDetail({ provider }),
              refreshed: (provider) => Message.ClickedRefreshUsage({ provider }),
            },
            h,
          ),
        ],
      ),
    ],
  ),
})
