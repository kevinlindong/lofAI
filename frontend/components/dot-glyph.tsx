"use client"

import type { CSSProperties } from "react"

// icons in the same idiom as everything else: struck on a dot grid rather than
// drawn as curves. a smooth vector icon in the middle of this interface looks
// like a sticker someone left on the panel.

export const GLYPHS = {
  play: ["X....", "XX...", "XXX..", "XXXX.", "XXXXX", "XXXX.", "XXX..", "XX...", "X...."],
  pause: ["XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX"],
  // back to the start, which is what reset means here
  rewind: ["X.....", "X....X", "X...XX", "X..XXX", "X...XX", "X....X", "X....."],
  // a shorter pair struck on one 5x7 grid, so each can morph into the other.
  // the triangle sits a column right of the bars: its weight lands mid-key
  playSmall: [".X...", ".XX..", ".XXX.", ".XXXX", ".XXX.", ".XX..", ".X..."],
  pauseSmall: ["XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX", "XX.XX"],
  moon: ["..XXX..", ".XX....", "XX.....", "XX.....", "XX.....", ".XX....", "..XXX.."],
  sun: ["...X...", ".X...X.", "..XXX..", "X.XXX.X", "..XXX..", ".X...X.", "...X..."],
  box: ["XXXXX", "X...X", "X...X", "X...X", "XXXXX"],
  check: [".....", "....X", "...X.", "X.X..", ".X..."],
  plus: ["..X..", "..X..", "XXXXX", "..X..", "..X.."],
  cross: ["X...X", ".X.X.", "..X..", ".X.X.", "X...X"],
  menu: ["XXXXXXX", ".......", "XXXXXXX", ".......", "XXXXXXX"],
  chevron: ["X...X", ".X.X.", "..X.."],
  settings: ["..XXX..", "X..X..X", "X.XXX.X", ".XX.XX.", "X.XXX.X", "X..X..X", "..XXX.."],
  music: ["..XXXXX", "..X...X", "..X...X", "..X...X", "XXX.XXX", "XXX.XXX", ".X...X."],
  list: ["X.XXXXX", ".......", "X.XXXXX", ".......", "X.XXXXX"],
  timer: ["..XXX..", "...X...", ".XXXXX.", "X..X..X", "X..XX.X", "X.....X", ".XXXXX."],
  // die faces for "new take": a die is already a dot matrix, and at 3x3 the
  // pips stay big enough to count at a glance
  die1: ["...", ".X.", "..."],
  die2: ["..X", "...", "X.."],
  die3: ["..X", ".X.", "X.."],
  die4: ["X.X", "...", "X.X"],
  die5: ["X.X", ".X.", "X.X"],
  die6: ["X.X", "X.X", "X.X"],
  pen: ["....XX", "...XXX", "..XXX.", ".XXX..", "XXX...", "X....."],
} as const

export type GlyphName = keyof typeof GLYPHS

interface DotPatternProps {
  rows: readonly string[]
  // side of one dot, in pixels
  dot?: number
  className?: string
  color?: string
  // keep every dot mounted and only mark it lit, so swapping to rows of the
  // same size can move dot by dot (app/timer.css animates .dot-morph)
  morph?: boolean
}

export function DotPattern({ rows, dot = 3, className, color = "currentColor", morph = false }: DotPatternProps) {
  const cols = rows[0].length
  const pitch = dot + 1

  return (
    <span
      className={morph ? `dot-morph${className ? ` ${className}` : ""}` : className}
      aria-hidden
      style={{
        display: "inline-grid",
        gridTemplateColumns: `repeat(${cols}, ${dot}px)`,
        gridAutoRows: `${dot}px`,
        gap: 1,
        width: cols * pitch - 1,
        height: rows.length * pitch - 1,
      }}
    >
      {rows.flatMap((row, r) =>
        row.split("").map((cell, c) => {
          const lit = cell === "X"
          return (
            <span
              key={`${r}-${c}`}
              data-on={(morph && lit) || undefined}
              style={
                morph
                  ? ({ borderRadius: "50%", background: color, opacity: lit ? 1 : 0, scale: lit ? "1" : "0", "--r": r, "--c": c } as CSSProperties)
                  : { borderRadius: "50%", background: lit ? color : "transparent" }
              }
            />
          )
        }),
      )}
    </span>
  )
}

export function DotGlyph({ name, ...props }: Omit<DotPatternProps, "rows"> & { name: GlyphName }) {
  return <DotPattern rows={GLYPHS[name]} {...props} />
}

export default DotGlyph
