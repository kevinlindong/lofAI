// Bringing a widget into view without fighting the desk: plain DOM, shared by
// the provider (taking one out) and the drag controller (a carry landing).

// How far the page must scroll for a frame to be in view: past the bottom of
// the window (or under the pull: the page's scroll padding keeps that clear),
// or above the top (its scroll margin keeps the menu clear). From its layout
// box, not what's on screen, so a frame still springing or rising into place
// is judged by where it will be. 0 when it's in view.
export function scrollToShow(frame: HTMLElement): number {
  const desk = frame.offsetParent instanceof HTMLElement ? frame.offsetParent : null
  if (!desk) return 0
  const top = desk.getBoundingClientRect().top + frame.offsetTop
  const bottom = top + frame.offsetHeight
  const style = getComputedStyle(frame)
  const below = bottom + (parseFloat(style.scrollMarginBottom) || 0) +
    (parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0) - window.innerHeight
  const above = top - (parseFloat(style.scrollMarginTop) || 0)
  if (above < 0) return above
  return below > 0.5 ? Math.min(below, above) : 0
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches

// A widget just set down out of the drawer is scrolled into view if it ends
// past the fold or under the pull, once it's placed. Boxes are fixed, so one
// look is enough.
export function showWhenPlaced(id: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const frame = document.getElementById(`widget-${id}`)
    const dy = frame && frame.isConnected ? scrollToShow(frame) : 0
    if (dy) window.scrollBy({ top: dy, behavior: reduced() ? "instant" : "smooth" })
  }))
}
