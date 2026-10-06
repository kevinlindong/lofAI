"use client"

import { DotGlyph } from "@/components/dot-glyph"
import { PomodoroTimer } from "@/components/pomodoro-timer"
import { useFocus } from "@/components/focus-provider"
import { useWidgetFrame } from "@/components/desk/widget-frame"
import type { WidgetDefinition, WidgetProps } from "@/components/desk/types"

// the clock lives in FocusProvider, so it keeps running while this is
// resized or put away
function Timer({ size }: WidgetProps) {
  const { setExpanded } = useWidgetFrame()
  return <PomodoroTimer size={size === "s" ? "s" : "m"} onExpandedChange={setExpanded} />
}

function Preview({ size }: { size: string }) {
  return (
    <span className="widget-preview preview-timer" data-size={size} aria-hidden>
      <span className="preview-digits">25:00</span>
      <span className="preview-meter" />
      {size !== "s" && <span className="preview-rails"><i /><i /></span>}
    </span>
  )
}

// one accent dot on the pull, breathing, while a block runs in the drawer;
// a small check once one has landed there, until it's answered
function Peek() {
  const { running, landing } = useFocus()
  if (landing) {
    return (
      <span className="peek peek-timer is-landed">
        <DotGlyph name="check" dot={1} color="var(--accent)" />
        <span className="sr-only">A focus block finished.</span>
      </span>
    )
  }
  if (!running) return null
  return <span className="peek peek-timer"><i aria-hidden /><span className="sr-only">The timer is still running.</span></span>
}

export const definition: WidgetDefinition = {
  type: "timer",
  name: "Focus timer",
  blurb: "A block of focus, then a rest.",
  sizes: [
    { id: "s", label: "just the time" },
    { id: "m", label: "with dials" },
  ],
  defaultSize: "m",
  surface: "card",
  maxInstances: 1,
  Component: Timer,
  Preview,
  Peek,
}
