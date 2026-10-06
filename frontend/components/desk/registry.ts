// Every widget type, in drawer order. A type whose module still exports a
// null definition isn't built yet: it never renders and never shows in the
// drawer, and a saved instance of it is kept for when it is.
import type { SizeId, Specs } from "@/lib/board"
import type { Surface, WidgetDefinition } from "@/components/desk/types"
import { definition as radio } from "@/components/widgets/radio"
import { definition as tasks } from "@/components/widgets/tasks"
import { definition as timer } from "@/components/widgets/timer"
import { definition as cat } from "@/components/widgets/cat"
import { definition as deskTask } from "@/components/widgets/desk-task"
import { definition as notebook } from "@/components/widgets/notebook"
import { definition as clock } from "@/components/widgets/clock"
import { definition as today } from "@/components/widgets/today"

const ALL: (WidgetDefinition | null)[] = [radio, tasks, timer, cat, deskTask, notebook, clock, today]

export const WIDGETS: WidgetDefinition[] = ALL.filter((def): def is WidgetDefinition => def !== null)

const BY_TYPE: Record<string, WidgetDefinition> = {}
for (const def of WIDGETS) BY_TYPE[def.type] = def

export function definitionOf(type: string): WidgetDefinition | null {
  return Object.prototype.hasOwnProperty.call(BY_TYPE, type) ? BY_TYPE[type] : null
}

// the surface a widget wears at a size
export function surfaceOf(def: WidgetDefinition, size: SizeId): Surface {
  return def.sizes.find((s) => s.id === size)?.surface ?? def.surface
}

// its label for a size ("mini player"), or the size's own name
export function sizeLabel(def: WidgetDefinition, size: SizeId): string {
  return def.sizes.find((s) => s.id === size)?.label ?? size
}

// the engine's view of the registry: the definitions fit it as they are
let specs: Specs | null = null
export function specsFor(): Specs {
  if (specs) return specs
  const out: Specs = {}
  for (const def of WIDGETS) out[def.type] = { sizes: def.sizes.map((s) => ({ id: s.id })), defaultSize: def.defaultSize, maxInstances: def.maxInstances }
  specs = out
  return out
}
