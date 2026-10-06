// How the focus timer lays itself out in the box it was given. Rows are no
// longer square (lib/board's colW × rowH), so "with dials" is anything from
// 428×184 down to 320×88: the same four parts — the label, the time with its
// keys, the progress and the two dials — have to read at every one of them.
// The widget measures its own box and these decide; the CSS follows
// `data-fit`, so the arrangement and the behaviour below can never disagree
// about which box this is. A box of 0 hasn't been measured yet (the first
// paint, and the server's): it reads as the roomy one.

export type TimerFit = "tall" | "wide" | "narrow"

// at least this tall and the four parts stack, as the card did before the
// desk: label, the time with its keys, the progress, Work and Rest side by side
export const TIMER_TALL_PX = 112
// a shorter box this wide puts the dials beside the time instead of under it
export const TIMER_WIDE_PX = 300
// and the landing note only fits under the time in a box this tall (the
// shortest that is, the 375×667 phone, is 131)
export const TIMER_NOTE_PX = 130

export function timerFit(width: number, height: number): TimerFit {
  if (!(height > 0) || height >= TIMER_TALL_PX) return "tall"
  return width >= TIMER_WIDE_PX ? "wide" : "narrow"
}

// Where a block that ran out says so. Under the time there is room for the
// whole note (the task, the words, [done] and the two offers); anywhere else
// one line takes the progress bar's place and opens the note in a sheet over
// the neighbours, exactly as "just the time" has always done.
export const landsInSheet = (height: number, size: "s" | "m") =>
  size === "s" || (height > 0 && height < TIMER_NOTE_PX)
