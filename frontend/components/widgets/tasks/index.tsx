"use client"

import { useEffect } from "react"
import { TodoList } from "@/components/todo-list"
import { useTasks } from "@/components/tasks-provider"
import { useWidgetFrame } from "@/components/desk/widget-frame"
import type { WidgetDefinition, WidgetProps } from "@/components/desk/types"

function Tasks({ size }: WidgetProps) {
  const { setMenuItems } = useWidgetFrame()
  const { tasks, openConnections, clearDone } = useTasks()
  const anyDone = tasks.some((task) => task.done)
  useEffect(() => {
    setMenuItems([
      { id: "connections", label: "Connections…", onSelect: openConnections },
      ...(anyDone ? [{ id: "clear-done", label: "Clear done", onSelect: clearDone }] : []),
    ])
  }, [setMenuItems, openConnections, clearDone, anyDone])
  // M is the short list: its header makes room for the input only while
  // something is being written, so every other pixel belongs to the rows
  return <TodoList short={size === "m"} />
}

function Preview({ size }: { size: string }) {
  return (
    <span className="widget-preview preview-tasks" data-size={size} aria-hidden>
      <span className="preview-line is-short" />
      {[0, 1, 2].map((i) => <span key={i} className="preview-task"><i /><span className="preview-line" /></span>)}
    </span>
  )
}

export const definition: WidgetDefinition = {
  type: "tasks",
  name: "Tasks",
  blurb: "A short list of small things.",
  // the list scrolls inside its box at either size
  sizes: [
    { id: "m", label: "short" },
    { id: "l", label: "list" },
  ],
  defaultSize: "l",
  surface: "card",
  maxInstances: 1,
  Component: Tasks,
  Preview,
}
