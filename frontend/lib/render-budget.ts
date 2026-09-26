// One page-wide switch between the full animation and a lighter mode that
// hands the GPU, memory bandwidth, and CPU back to the live model.
//
// The model shares one chip with this page. On a machine where it renders
// close to real time (an 8GB M1 Air, or any laptop while something else is
// busy), the visualiser, the cat, blurred glass, and drifting CSS marks are
// competing for exactly the budget that keeps the music from gapping. Low
// power keeps every design element but paints it less often: canvas loops
// drop their frame rate, the cursor trail stops, and decorative CSS motion
// and backdrop blur switch off through the `low-power` class on <html>.
//
// Plain module state rather than React state: canvas loops consult it every
// frame and must not re-render anything when it flips.

type Listener = () => void

let active = false
const listeners = new Set<Listener>()

export function lowPowerActive(): boolean {
  return active
}

export function setLowPower(next: boolean) {
  if (next === active) return
  active = next
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.classList.toggle("low-power", next)
  }
  for (const listener of Array.from(listeners)) listener()
}

export function onLowPowerChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Enter as soon as the backend is short of headroom; leave only after a long
// healthy stretch at a clearly higher speed. Low power itself frees headroom,
// so a symmetric rule would oscillate: visuals return, the model slows, and
// the page drops back a minute later.
export const ENTER_REALTIME_FACTOR = 1.45
export const EXIT_REALTIME_FACTOR = 1.7
export const TROUBLE_MEMORY_MS = 90_000
export const MIN_LOW_POWER_MS = 120_000
export const LOW_WATER_SECONDS = 0.3
// A freshly started bank, a tab hiccup, or one doubled splice chunk all dip
// the reservoir for a moment; only a sustained low reservoir is pressure.
export const LOW_WATER_SUSTAIN_MS = 3_000

export interface BackendHealth {
  realtimeFactor: number
  codebooks?: number
  maxCodebooks?: number
}

// Decides low power from what the stream already measures. Timestamps are
// passed in so the policy is testable without a clock.
export class LoadGovernor {
  private low = false
  private lowWaterSince: number | null = null
  private lastTroubleAt = -Infinity
  private enteredAt = -Infinity
  private health: BackendHealth | null = null

  constructor(private readonly apply: (lowPower: boolean) => void = setLowPower) {}

  noteHealth(health: BackendHealth, now: number) {
    this.health = health
    const { realtimeFactor, codebooks, maxCodebooks } = health
    const slow = realtimeFactor > 0 && realtimeFactor < ENTER_REALTIME_FACTOR
    // The backend spends codec detail before it lets a stream gap, so a
    // reduced depth is itself the sign that it is short of time.
    const spending =
      typeof codebooks === "number" && typeof maxCodebooks === "number" && codebooks < maxCodebooks
    if (slow || spending) this.trouble(now)
    else this.maybeExit(now)
  }

  noteBuffer(playing: boolean, bufferedSeconds: number, now: number) {
    if (!(playing && bufferedSeconds < LOW_WATER_SECONDS)) {
      this.lowWaterSince = null
      this.maybeExit(now)
      return
    }
    if (this.lowWaterSince === null) this.lowWaterSince = now
    if (now - this.lowWaterSince >= LOW_WATER_SUSTAIN_MS) this.trouble(now)
  }

  noteUnderrun(now: number) {
    this.trouble(now)
  }

  private trouble(now: number) {
    this.lastTroubleAt = now
    if (!this.low) {
      this.low = true
      this.enteredAt = now
      this.apply(true)
    }
  }

  private maybeExit(now: number) {
    if (!this.low) return
    const health = this.health
    if (!health) return
    const fast = health.realtimeFactor >= EXIT_REALTIME_FACTOR
    const full =
      typeof health.codebooks !== "number" ||
      typeof health.maxCodebooks !== "number" ||
      health.codebooks >= health.maxCodebooks
    if (
      fast &&
      full &&
      now - this.lastTroubleAt >= TROUBLE_MEMORY_MS &&
      now - this.enteredAt >= MIN_LOW_POWER_MS
    ) {
      this.low = false
      this.apply(false)
    }
  }
}
