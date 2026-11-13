/**
 * What the page reads off the screen: the pipeline's flow, and the width an
 * element has to draw in.
 */
import type { Flow } from "foreman/pipeline-view";
import { type RefCallback, useCallback, useState, useSyncExternalStore } from "react";

const PORTRAIT = "(orientation: portrait)";

/**
 * The pipeline's flow for this screen: `down` when the viewport is taller than
 * it is wide, as on a phone held upright, else `across`. The pane picks its
 * flow by the same rule.
 */
export const useFlow = (): Flow =>
  useSyncExternalStore(subscribePortrait, () =>
    globalThis.matchMedia(PORTRAIT).matches ? "down" : "across",
  );

const subscribePortrait = (onChange: () => void) => {
  const query = globalThis.matchMedia(PORTRAIT);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/**
 * The content width of the element the returned ref is attached to, 0 until
 * it is attached, and again after each resize.
 */
export const useWidth = (): readonly [width: number, ref: RefCallback<Element>] => {
  const [width, setWidth] = useState(0);
  const ref = useCallback((element: Element | null) => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [width, ref];
};
