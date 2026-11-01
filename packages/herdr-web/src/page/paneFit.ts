// Folds a pane's tools into its menu when they would crowd its name. Whether
// they fit depends on the head's content (the name, the model tag, a close to
// confirm) as well as its width, which no CSS rule can measure, so this
// watches each pane head and marks it `data-folded` (see styles.css). The
// mark is a fact of layout, like a container query, so it lives on the
// element and not in the page's model.
import { Array, Effect } from "effect"

/**
 * Watches every pane head under `root` while the scope lasts. The root is
 * the body: the page's renderer replaces its own container element.
 */
export const fitPaneTools = (root: HTMLElement) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const watched = new Set<HTMLElement>()
      // A measurement adds and removes its copy in the body; its records are dropped, so it does not wake the watcher.
      const refit = (head: HTMLElement) => {
        fit(head)
        changes.takeRecords()
      }
      const resizes = new ResizeObserver((entries) => Array.forEach(entries, ({ target }) => target instanceof HTMLElement && refit(target)))
      let isDue = false
      // A new head, a new name or model tag, or a close to confirm can change the fit; output in a terminal or chat cannot.
      const changes = new MutationObserver((mutations) => {
        if (isDue || !Array.some(mutations, ({ target }) => !(target instanceof Element && target.closest(".terminal, .chat")))) {
          return
        }
        isDue = true
        requestAnimationFrame(() => {
          isDue = false
          Array.forEach([...watched], (head) => {
            if (!head.isConnected) {
              resizes.unobserve(head)
              watched.delete(head)
            }
          })
          Array.forEach([...root.querySelectorAll(".pane-head")], (head) => {
            if (head instanceof HTMLElement) {
              if (!watched.has(head)) {
                watched.add(head)
                resizes.observe(head)
              }
              refit(head)
            }
          })
        })
      })
      changes.observe(root, { childList: true, subtree: true, characterData: true })
      return { resizes, changes }
    }),
    ({ resizes, changes }) =>
      Effect.sync(() => {
        changes.disconnect()
        resizes.disconnect()
      }),
  )

/**
 * Marks the head folded when it is narrower than its parts need with the
 * tools beside them: the name at its full width, the parts that do not
 * shrink, and the tools as they lay out unfolded. The status note shrinks to
 * nothing, and the menu button is not counted, so the result is the same
 * folded or not and the head does not flip back and forth.
 */
const fit = (head: HTMLElement) => {
  const name = head.querySelector(".name")
  const tools = head.querySelector(".pane-tools")
  if (!(name instanceof HTMLElement) || !(tools instanceof HTMLElement)) {
    return
  }
  const fixed = Array.filter([...head.children], (child) => child !== name && child !== tools && !child.matches(".msg, .pane-menu-button"))
  const toolsWidth = unfoldedWidth(tools)
  const gap = parseFloat(getComputedStyle(head).columnGap) || 0
  const parts = fixed.length + 2
  const need = Array.reduce(fixed, 0, (sum, child) => sum + child.getBoundingClientRect().width) + name.scrollWidth + toolsWidth + gap * parts
  head.toggleAttribute("data-folded", head.clientWidth < need)
}

/**
 * The tools' width laid out in a row, as the head shows them unfolded with
 * the pointer over it. A hidden copy is measured outside the app, so the
 * measurement does not move the page.
 */
const unfoldedWidth = (tools: HTMLElement) => {
  const probe = tools.cloneNode(true)
  if (!(probe instanceof HTMLElement)) {
    return 0
  }
  probe.className = "pane-tools-probe"
  document.body.append(probe)
  const { width } = probe.getBoundingClientRect()
  probe.remove()
  return width
}
