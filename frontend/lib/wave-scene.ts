// the music, as a radial bar graph.
//
// one wedge per band, standing out from the key (see components/dot-visualizer),
// each a little honeycomb of liquid dots lit out to its band's level. the
// spectrum is laid out like a face, mirrored about the vertical: the bass pair
// meets at the top, the highs meet at the bottom, and the mids fill the two
// sides. a kick lifts the crown, a snare flares the shoulders and the chin,
// and the ring stays balanced on its own axis instead of leaning off to one
// side wherever the loudest band happens to sit.
//
// nothing else is drawn. the wedges are the whole visualiser, and every mark
// on the panel is a dot of the matrix - so anything off it reads as dirt on
// the lens rather than as information.

export const BANDS = 24
export const WEDGES = (globalThis as any).__wedges ?? BANDS * 2

// which band a wedge shows: clockwise from the top down the right side, and
// back up the left as its mirror
export function bandOf(wedge: number) {
  const half = WEDGES / 2
  const side = wedge < half ? wedge : WEDGES - 1 - wedge
  return Math.min(BANDS - 1, Math.round(side * (BANDS - 1) / (half - 1)))
}

// the wedges' ink at rest, a step softer, deepening once the music arrives
export const WAVE_REST = 3
export const WAVE_LIVE = 4
