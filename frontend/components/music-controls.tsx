"use client"

import { DotGlyph } from "@/components/dot-glyph"
import { DotVisualizer } from "@/components/dot-visualizer"
import { SoundPanel } from "@/components/sound-panel"
import { useRadio } from "@/components/radio-provider"

export function MusicControls() {
  const { wantsAudio, togglePlayback, label, isLive, getSpectrum } = useRadio()

  return (
    <div className="music-panel">
      <div className="visualizer-stage">
        <DotVisualizer getSpectrum={getSpectrum} active={isLive}>
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={togglePlayback}
              aria-label={wantsAudio ? "Pause" : "Play"}
              aria-pressed={wantsAudio}
              className="key play-key"
            >
              <DotGlyph name={wantsAudio ? "pause" : "play"} dot={4} />
            </button>
            <span className="play-status">{label}</span>
          </div>
        </DotVisualizer>
      </div>

      <SoundPanel />
    </div>
  )
}

export default MusicControls
