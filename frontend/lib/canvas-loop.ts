import { lowPowerActive, onLowPowerChange, renderBusy } from "./render-budget"

export interface LoopRate {
  // Frames per second while the page has headroom. Defaults to 60.
  fps?: number
  // Frames per second in low power, and while the desk is being arranged
  // (see render-budget). Keep it at 20 or above: the scenes integrate at
  // most 0.05 s per frame, so a slower loop would play its motion in slow
  // motion rather than more coarsely.
  lowPowerFps?: number
}

// Keep motion at 60fps without doing twice the painting on a 120Hz display.
// Hidden/offscreen canvases stop entirely; resuming starts with a small dt.
export function canvasLoop(
  element: Element,
  draw: (now: number, dt: number) => void,
  still: () => void,
  rate: LoopRate = {},
) {
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
  const fullFps = rate.fps ?? 60
  const lowFps = rate.lowPowerFps ?? fullFps
  // arranging the desk (renderBusy) paints at the low-power rate too
  const intervalNow = () => 1000 / (lowPowerActive() || renderBusy() ? lowFps : fullFps)
  let interval = intervalNow()
  let visible = true
  let disposed = false
  let raf = 0
  let previous = 0
  let due = 0

  const tick = (now: number) => {
    if (now + 0.5 >= due) {
      draw(now, previous ? Math.min(0.05, (now - previous) / 1000) : 1 / 60)
      previous = now
      due = Math.max(due + interval, now)
    }
    raf = requestAnimationFrame(tick)
  }

  const sync = () => {
    cancelAnimationFrame(raf)
    raf = 0
    previous = 0
    due = 0
    if (disposed || document.hidden || !visible) return
    if (motion.matches) still()
    else raf = requestAnimationFrame(tick)
  }

  const observer = new IntersectionObserver(([entry]) => {
    if (visible === entry.isIntersecting) return
    visible = entry.isIntersecting
    sync()
  })
  observer.observe(element)
  document.addEventListener("visibilitychange", sync)
  motion.addEventListener("change", sync)
  const stopWatchingPower = onLowPowerChange(() => {
    interval = intervalNow()
    due = 0
  })
  sync()

  return {
    redraw() {
      if (!disposed && !document.hidden && visible && motion.matches) still()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      document.removeEventListener("visibilitychange", sync)
      motion.removeEventListener("change", sync)
      stopWatchingPower()
    },
  }
}
