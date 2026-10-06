// What a widget module hands the desk. Each type lives in
// components/widgets/<type>/index.tsx and exports `definition`; the registry
// collects the ones that are built.
import type { ComponentType } from "react"
import type { Bucket, Form, Rect, SizeId, WidgetType } from "@/lib/board"

export type Surface = "card" | "bare"

// one of the four standard sizes, with the widget's own name for it. A size
// can wear a different surface than its type (the clock's time is bare, its
// day a card)
export interface WidgetSize { id: SizeId; label: string; surface?: Surface }

export interface WidgetProps {
  id: string
  size: SizeId
  // "tall": xl below six columns, the same content stacked 2×4
  form: Form
  bucket: Bucket
}

// the drawer tile's picture: static dot art at the widget's proportions,
// never a canvas and never a live control
export interface PreviewProps { size: SizeId }

export interface WidgetDefinition {
  type: WidgetType
  // its title: the tile, the frame's label, the grip ("Move {name}")
  name: string
  // what sentences call it ("{spokenName} is in the drawer."), when the title
  // reads badly there. defaults to the name
  spokenName?: string
  blurb: string
  // small to large, a subset of s m l xl
  sizes: WidgetSize[]
  defaultSize: SizeId
  surface: Surface
  anchor?: "bottom"
  maxInstances: number
  Component: ComponentType<WidgetProps>
  Preview: ComponentType<PreviewProps>
  // a little sign on the drawer pull while the widget is inside (it renders
  // nothing when there's nothing to say), with an sr-only sentence
  Peek?: ComponentType
}

// widget extras in the grip menu (useWidgetFrame().setMenuItems)
export interface MenuItem {
  id: string
  label: string
  hint?: string
  checked?: boolean
  disabled?: boolean
  onSelect: () => void
}

// the desk's own happenings, for anything that wants to react (the cat).
// "layout": the frames as drawn changed (useDesk().shown() has them);
// "pin": a widget was pinned or unpinned (the strike, for an ear flick);
// "resist": a pinned widget was tugged
export type DeskEvent =
  | { kind: "lift"; id: string }
  | { kind: "drop"; id: string; rect: Rect | null }
  | { kind: "cancel"; id: string }
  | { kind: "put-away"; id: string }
  | { kind: "take-out"; id: string }
  | { kind: "pin"; id: string; on: boolean }
  | { kind: "resist"; id: string }
  | { kind: "layout" }

// a frame as the desk last drew it: its committed slot, whether it has a
// surface to sit on, and whether it's on its way into the drawer
export interface ShownFrame extends Rect { id: string; bare: boolean; leaving: boolean }
export interface ShownDesk { bucket: Bucket; frames: ShownFrame[] }
