"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { lowPowerActive } from "@/lib/render-budget"

const STAGGER_MS = 14
const LETTER_MS = 560

// New text arrives a letter at a time, each springing up into place. Once
// the last letter lands it becomes plain text again, so kerning, ligatures
// and line breaking are exactly what they would be without the animation.
// New text plays it again; so does a new `replay` value.
export function RollingText({ text, delay = 0, replay }: { text: string; delay?: number; replay?: number | string }) {
  return <Letters key={`${text}\u0000${replay ?? ""}`} text={text} delay={delay} />
}

function Letters({ text, delay }: { text: string; delay: number }) {
  const [settled, setSettled] = useState(false)
  const letters = text.replace(/\s/g, "").length

  useEffect(() => {
    const still = lowPowerActive() || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (still) { setSettled(true); return }
    const timer = window.setTimeout(() => setSettled(true), delay + letters * STAGGER_MS + LETTER_MS)
    return () => window.clearTimeout(timer)
  }, [delay, letters])

  if (settled) return <>{text}</>

  let index = 0
  return (
    <span className="rolling-text" aria-hidden style={{ "--delay": `${delay}ms` } as CSSProperties}>
      {text.split(/(\s+)/).map((part, i) =>
        /^\s+$/.test(part) ? part : (
          // words stay whole so the line still breaks between them
          <span key={i} className="rolling-word">
            {Array.from(part).map((letter) => (
              <span key={index} className="rolling-letter" style={{ "--i": index++ } as CSSProperties}>{letter}</span>
            ))}
          </span>
        ),
      )}
    </span>
  )
}

export default RollingText
