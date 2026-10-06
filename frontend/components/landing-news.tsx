"use client"

import { useEffect, useRef } from "react"
import { useDesk } from "@/components/desk/desk-provider"
import { useFocus } from "@/components/focus-provider"
import { useTasks } from "@/components/tasks-provider"
import { blockStart, creditedTask, landingNews } from "@/lib/land-softly"

// A focus block that runs out is said aloud once, from here: whichever
// widget draws its note (the timer, or On the desk when it's out), and even
// with both tucked in the drawer. A landing is only ever set as a block
// ends, never restored on load, so nothing old is said again.
export function LandingNews() {
  const { landing, sessions } = useFocus()
  const { tasks } = useTasks()
  const { announce } = useDesk()
  const heard = useRef<number | null>(null)
  useEffect(() => {
    if (!landing || heard.current === landing.at) return
    heard.current = landing.at
    const task = creditedTask(tasks, landing, blockStart(sessions, landing))
    announce(landingNews(landing.minutes, task?.text ?? null))
  }, [landing, tasks, sessions, announce])
  return null
}

export default LandingNews
