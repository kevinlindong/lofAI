// websocket client for the magenta realtime 2 backend
//
// the backend sends a continuous stream of interleaved 16-bit pcm chunks over a
// websocket. an <audio> element cannot play that - it wants a container format
// with a known length - so we feed the chunks into an AudioWorklet that owns a
// ring buffer and one fractional read cursor, and it turns them into a single
// continuous signal on the audio thread.
//
// that last part is the whole point. the obvious approach - one
// AudioBufferSourceNode per chunk, scheduled from a timer - fails twice over:
// the timer runs on the main thread, so a busy tab schedules late and the
// stream clicks, and each source resamples from its own phase, so any playback
// rate other than 1.0 puts a discontinuity at every chunk seam. on this stream
// that was a tick two or three times a second. the worklet has no seams to
// click at and cannot be starved by rendering work.
//
// the reservoir is still here, because generation speed varies by machine, but
// it is sized from the real time factor the backend measures rather than
// assumed to be needed.

export type StreamStatus =
  | "idle"
  | "connecting"
  | "loading"
  | "queued"
  | "buffering"
  | "live"
  | "paused"
  | "error"

export interface StreamState {
  status: StreamStatus
  queuePosition: number
  listeners: number
  capacity: number
  message: string | null
  // 0..1 progress while filling the reservoir, for the UI
  bufferProgress: number
  variationPending: boolean
}

export interface ListenerControls {
  station: string
  drums: boolean
  // Free-text style prompt; only meaningful for the custom station. Empty
  // string means "use the selected station".
  customPrompt: string
  // Granular dials, normalized 0..1. The backend maps them onto safe
  // MusicCoCa guidance (adherence) and sampler temperature (variation).
  adherence: number
  variation: number
}

// Receives the stream's own load signals. The page uses them to decide how
// much animation it can afford beside the model (see lib/render-budget).
export interface StreamLoadObserver {
  noteHealth(
    health: { realtimeFactor: number; codebooks?: number; maxCodebooks?: number },
    now: number,
  ): void
  noteBuffer(playing: boolean, bufferedSeconds: number, now: number): void
  noteUnderrun(now: number): void
}

export const DEFAULT_LISTENER_CONTROLS: ListenerControls = {
  station: "dusty-beats",
  drums: true,
  customPrompt: "",
  adherence: 0.5,
  variation: 0.5,
}

// Keep the free-text prompt short: a long adjective pile-up dilutes MusicCoCa
// conditioning rather than sharpening it, and the backend caps it anyway.
export const MAX_CUSTOM_PROMPT_CHARS = 120

interface Reservoir {
  prebufferSeconds: number
  rebufferSeconds: number
  comfortSeconds: number
  minRate: number
}

// how deep to bank before playing, as a function of how much faster than real
// time the backend says it is rendering.
//
// A buffer cannot repair a renderer that is permanently below 1x; it can only
// postpone the gap. Start healthy streams below a second; add bounded jitter
// slack only after an audible gap, and let the backend adjust measured cost.
function reservoirFor(realtimeFactor: number): Reservoir {
  if (realtimeFactor <= 0) {
    return { prebufferSeconds: 0.8, rebufferSeconds: 0.8, comfortSeconds: 1.6, minRate: 1 }
  }
  if (realtimeFactor >= 1.18) {
    return { prebufferSeconds: 0.64, rebufferSeconds: 0.8, comfortSeconds: 1.4, minRate: 1 }
  }
  if (realtimeFactor >= 1.0) {
    return { prebufferSeconds: 0.9, rebufferSeconds: 1.0, comfortSeconds: 1.8, minRate: 1 }
  }
  return { prebufferSeconds: 1.2, rebufferSeconds: 1.4, comfortSeconds: 2.2, minRate: 1 }
}

const WORKLET_URL = "/mrt-pcm-worklet.js"
const RING_SECONDS = 8
const GAP_MARGIN_SECONDS = 0.2
const MAX_GAP_MARGIN_SECONDS = 0.8
const FATAL_SERVER_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1011])
const SESSION_MAX_AGE_MS = 4 * 60 * 1000

// The model's PCM is deliberately conservative: its int16 stage applies a
// fixed 0.5 gain (about -6 dB) for headroom, so program RMS lands around
// -21 to -26 dBFS. That known constant is undone by a fixed makeup stage.
// Keep this gain fixed. Even a bounded +3 dB adaptive trim gradually raises
// the model/codec noise floor during mellow passages. Musical dynamics should
// not change the playback gain, and a fixed stage needs no analyser or polling.
const MAKEUP_GAIN_DB = 5

class SinkBuildCancelled extends Error {}

// sessionStorage rather than localStorage: it survives a reload but is scoped
// to the tab, so a second tab opens a second stream instead of both trying to
// resume the same one
const SESSION_KEY = "lofai.sessionId"

function backendHost(): string {
  return process.env.NEXT_PUBLIC_BACKEND_HOST ?? "localhost:8000"
}

function readSessionId(): string | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null

    // Plain string IDs predate the timestamped record. They may already refer
    // to an evicted backend session, so migrate safely by starting one fresh
    // take instead of replaying the same deterministic seed forever.
    const stored = JSON.parse(raw) as { version?: unknown; id?: unknown; savedAt?: unknown }
    if (
      stored.version !== 1 ||
      typeof stored.id !== "string" ||
      !stored.id ||
      typeof stored.savedAt !== "number" ||
      Date.now() - stored.savedAt > SESSION_MAX_AGE_MS
    ) {
      window.sessionStorage.removeItem(SESSION_KEY)
      return null
    }
    return stored.id
  } catch {
    try {
      window.sessionStorage.removeItem(SESSION_KEY)
    } catch {
      // private browsing can reject storage access entirely
    }
    return null
  }
}

function writeSessionId(id: string) {
  try {
    if (!id) return
    window.sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ version: 1, id, savedAt: Date.now() }),
    )
  } catch {
    // private browsing - the session just won't survive a reload
  }
}

function clearSessionId() {
  try {
    window.sessionStorage.removeItem(SESSION_KEY)
  } catch {
    // private browsing - there is no persistent session to clear
  }
}

function clamp01(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function normalizedControls(
  next: Partial<ListenerControls>,
  previous: ListenerControls = DEFAULT_LISTENER_CONTROLS,
): ListenerControls {
  return {
    station:
      typeof next.station === "string" && next.station.trim()
        ? next.station.trim()
        : previous.station,
    drums: typeof next.drums === "boolean" ? next.drums : previous.drums,
    customPrompt:
      typeof next.customPrompt === "string"
        ? next.customPrompt.replace(/\s+/g, " ").trimStart().slice(0, MAX_CUSTOM_PROMPT_CHARS)
        : previous.customPrompt,
    adherence: clamp01(next.adherence, previous.adherence),
    variation: clamp01(next.variation, previous.variation),
  }
}

function controlsEqual(a: ListenerControls, b: ListenerControls): boolean {
  return (
    a.station === b.station &&
    a.drums === b.drums &&
    a.customPrompt === b.customPrompt &&
    a.adherence === b.adherence &&
    a.variation === b.variation
  )
}

function dbToGain(db: number): number {
  return 10 ** (db / 20)
}

// what the stream needs from whatever is actually making sound
interface PcmSink {
  readonly output: AudioNode
  push(pcm: ArrayBuffer): void
  play(fresh: boolean): void
  stop(): void
  reset(): void
  configure(reservoir: Reservoir): void
  dispose(): void
}

interface SinkReport {
  playing: boolean
  buffered: number
  need: number
}

// --- the real one: a ring buffer on the audio thread ---

class WorkletSink implements PcmSink {
  private disposed = false

  constructor(
    private node: AudioWorkletNode,
    onReport: (report: SinkReport) => void,
    onStarved: () => void,
  ) {
    node.port.onmessage = (event) => {
      const data = event.data
      if (data.type === "starved") onStarved()
      else if (data.type === "state") onReport(data as SinkReport)
    }
  }

  get output(): AudioNode {
    return this.node
  }

  push(pcm: ArrayBuffer) {
    // Keep the network's int16 representation all the way into the worklet.
    // The transfer is zero-copy and conversion happens only for samples that
    // actually reach the speakers.
    this.node.port.postMessage({ type: "pcm", pcm }, [pcm])
  }

  play(fresh: boolean) {
    this.node.port.postMessage({ type: "play", fresh })
  }

  stop() {
    this.node.port.postMessage({ type: "stop" })
  }

  reset() {
    this.node.port.postMessage({ type: "reset" })
  }

  configure(reservoir: Reservoir) {
    this.node.port.postMessage({ type: "config", ...reservoir })
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.node.port.onmessage = null
    this.node.port.postMessage({ type: "dispose" })
    this.node.port.close()
    this.node.disconnect()
  }
}

// --- the fallback: chunk scheduling from a timer ---
//
// only used where AudioWorklet is missing or its module will not load. it has
// the seam problem described at the top of the file, so it plays at a flat 1.0
// and simply refills when it runs dry rather than stretching - a longer pause,
// but no ticking.

class TimerSink implements PcmSink {
  private gate: GainNode
  private queue: AudioBuffer[] = []
  private queuedSeconds = 0
  private scheduled: AudioBufferSourceNode[] = []
  private nextStart = 0
  private playing = false
  private want = false
  private need: number
  private fresh = true
  private ticker: ReturnType<typeof setInterval>
  private reservoir = reservoirFor(0)
  private disposed = false

  constructor(
    private ctx: AudioContext,
    private channels: number,
    // the stream's rate, not the context's: on a device that refused 48k these
    // differ, and declaring the buffer at the source rate is what makes the
    // browser resample it instead of playing it sharp
    private sourceRate: number,
    private onReport: (report: SinkReport) => void,
    private onStarved: () => void,
  ) {
    this.gate = ctx.createGain()
    this.gate.gain.value = 0
    this.need = this.reservoir.prebufferSeconds
    this.ticker = setInterval(() => this.tick(), 60)
  }

  get output(): AudioNode {
    return this.gate
  }

  push(pcm: ArrayBuffer) {
    if (this.disposed) return
    const samples = new Int16Array(pcm)
    const frames = Math.floor(samples.length / this.channels)
    if (frames === 0) return
    const buffer = this.ctx.createBuffer(this.channels, frames, this.sourceRate)
    for (let channel = 0; channel < this.channels; channel++) {
      const target = buffer.getChannelData(channel)
      for (let frame = 0; frame < frames; frame++) {
        target[frame] = samples[frame * this.channels + channel] / 32768
      }
    }
    this.queue.push(buffer)
    this.queuedSeconds += buffer.duration
  }

  play(fresh: boolean) {
    if (this.disposed) return
    this.want = true
    if (!this.playing) {
      this.fresh = fresh
      this.need = fresh
        ? this.reservoir.prebufferSeconds
        : this.reservoir.rebufferSeconds
    }
  }

  stop() {
    if (this.disposed) return
    this.want = false
    this.fadeTo(0)
    this.playing = false
  }

  reset() {
    if (this.disposed) return
    this.stopScheduled()
    this.queue = []
    this.queuedSeconds = 0
    this.playing = false
    this.fresh = true
    this.need = this.reservoir.prebufferSeconds
  }

  configure(reservoir: Reservoir) {
    if (this.disposed) return
    this.reservoir = reservoir
    if (!this.playing) {
      this.need = this.fresh ? reservoir.prebufferSeconds : reservoir.rebufferSeconds
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.ticker)
    this.want = false
    this.playing = false
    this.queue = []
    this.queuedSeconds = 0
    for (const source of this.scheduled) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // already finished
      }
      source.disconnect()
    }
    this.scheduled = []
    this.nextStart = 0
    this.gate.disconnect()
  }

  private buffered(): number {
    return this.queuedSeconds + Math.max(0, this.nextStart - this.ctx.currentTime)
  }

  private tick() {
    if (this.disposed) return
    const buffered = this.buffered()
    if (this.want) {
      if (!this.playing) {
        if (buffered >= this.need) {
          this.playing = true
          // Pausing suspends the context with already-scheduled sources still
          // queued. Continue after their end; moving this cursor back would
          // overlap the next chunk with them when playback resumes.
          this.nextStart = Math.max(this.nextStart, this.ctx.currentTime + 0.05)
          this.fadeTo(1)
        }
      } else if (this.queuedSeconds <= 0 && this.nextStart - this.ctx.currentTime < 0.15) {
        this.fadeTo(0)
        this.playing = false
        this.fresh = false
        this.need = this.reservoir.rebufferSeconds
        this.onStarved()
      }
      if (this.playing) this.pump()
    }
    this.onReport({ playing: this.playing, buffered, need: this.need })
  }

  private pump() {
    while (this.queue.length > 0 && this.nextStart - this.ctx.currentTime < 0.5) {
      const buffer = this.queue.shift() as AudioBuffer
      this.queuedSeconds -= buffer.duration
      const source = this.ctx.createBufferSource()
      source.buffer = buffer
      source.connect(this.gate)
      if (this.nextStart < this.ctx.currentTime + 0.02) {
        this.nextStart = this.ctx.currentTime + 0.02
      }
      source.start(this.nextStart)
      this.nextStart += buffer.duration
      this.scheduled.push(source)
      source.onended = () => {
        source.onended = null
        source.disconnect()
        this.scheduled = this.scheduled.filter((node) => node !== source)
      }
    }
  }

  private fadeTo(value: number) {
    const now = this.ctx.currentTime
    this.gate.gain.cancelScheduledValues(now)
    this.gate.gain.setValueAtTime(this.gate.gain.value, now)
    this.gate.gain.linearRampToValueAtTime(value, now + 0.08)
  }

  private stopScheduled() {
    for (const source of this.scheduled) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // already finished
      }
      source.disconnect()
    }
    this.scheduled = []
    this.nextStart = 0
  }
}

export class MrtStream {
  private ws: WebSocket | null = null
  private ctx: AudioContext | null = null
  private sink: PcmSink | null = null
  private sinkReady: Promise<PcmSink> | null = null
  private makeup: GainNode | null = null
  private limiter: DynamicsCompressorNode | null = null
  private ceiling: GainNode | null = null
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private levelBuffer: Uint8Array = new Uint8Array(0)
  private freqBuffer: Uint8Array = new Uint8Array(0)

  private sampleRate = 48000
  private channels = 2

  private volume = 1
  private controls: ListenerControls = { ...DEFAULT_LISTENER_CONTROLS }
  private wantsAudio = false
  private backendActive = false
  private awaitingVariation = false
  private requestedSessionId: string | null = null
  private activeSessionId: string | null = null
  private lastSessionPersistedAt = 0
  private realtimeFactor = 0
  private recoveryMarginSeconds = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private suspendTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 500
  private lastPressureAt = 0
  private pendingPcm: ArrayBuffer[] = []
  private destroyed = false
  private sinkGeneration = 0
  private destroyPromise: Promise<void> | null = null

  private state: StreamState = {
    status: "idle",
    queuePosition: 0,
    listeners: 0,
    capacity: 0,
    message: null,
    bufferProgress: 0,
    variationPending: false,
  }

  constructor(
    private onState: (state: StreamState) => void,
    private load: StreamLoadObserver | null = null,
  ) {}

  // --- public api ---

  async start(controls: ListenerControls) {
    if (this.destroyed) return
    this.controls = normalizedControls(controls, this.controls)
    this.wantsAudio = true
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer)
      this.suspendTimer = null
    }
    const ctx = this.ensureContext()
    // browsers start the context suspended until a user gesture; this call is
    // inside the click handler, so it is allowed to resume. it goes before the
    // await so the gesture is still on the stack when it lands.
    const resumed = ctx.resume()

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      // already have a socket - unpause on it rather than opening a second one.
      // while still connecting this is a no-op, and the hello we send on open
      // does the same job.
      this.send({ type: "resume" })
    } else {
      // WebSocket/model startup and AudioWorklet fetch+compile are independent;
      // overlap them so cold-start latency is their maximum, not their sum.
      this.connect()
    }

    const sink = await this.currentSink()
    await resumed
    // the module load is a round trip, and pause is one click away
    if (!sink || this.destroyed || !this.wantsAudio) return
    sink.play(true)
  }

  pause() {
    if (this.destroyed) return
    this.persistSessionId(true)
    this.wantsAudio = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.close()
    else this.send({ type: "pause" })
    this.sink?.stop()
    // Let the audio-thread fade complete, then stop consuming CPU (and stop
    // TimerSink sources from advancing silently) for the rest of the pause.
    if (this.ctx) {
      const ctx = this.ctx
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null
        if (!this.wantsAudio && ctx.state !== "closed") void ctx.suspend()
      }, 80)
    }
    this.patch({ status: "paused", bufferProgress: 0 })
  }

  setControls(next: ListenerControls) {
    if (this.destroyed) return
    const controls = normalizedControls(next, this.controls)
    if (controlsEqual(controls, this.controls)) return
    this.controls = controls
    this.send({ type: "controls", ...controls })
  }

  newVariation() {
    if (this.destroyed) return

    // Audio and model state on opposite sides of this request must never meet
    // in the same ring buffer. WebSocket ordering means that after the ack all
    // following binary packets belong to the new take.
    clearSessionId()
    this.requestedSessionId = null
    this.activeSessionId = null
    this.pendingPcm = []
    this.resetRecoveryMargin()
    this.sink?.reset()
    this.awaitingVariation = true
    this.patch({
      status: this.wantsAudio ? "buffering" : "paused",
      message: null,
      bufferProgress: 0,
      variationPending: true,
    })

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "variation" })
      return
    }

    // If hello has not gone out yet, clearing storage is enough: that socket
    // will request a brand-new session. A disconnected playing stream needs a
    // fresh connection immediately.
    if (!this.ws && this.wantsAudio) this.connect()
  }

  setVolume(value: number) {
    if (this.destroyed) return
    this.volume = value
    if (this.gain && this.ctx) {
      // a short ramp instead of a step, so dragging the slider doesn't click
      this.gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.02)
    }
  }

  // instantaneous output level in 0..1, for the visualiser
  level(): number {
    if (!this.analyser) return 0
    this.analyser.getByteTimeDomainData(this.levelBuffer)

    let sum = 0
    for (let i = 0; i < this.levelBuffer.length; i++) {
      const centred = (this.levelBuffer[i] - 128) / 128
      sum += centred * centred
    }
    return Math.sqrt(sum / this.levelBuffer.length)
  }

  // frequency magnitudes in 0..255, for the visualiser. returns the number of
  // bins written, or 0 if there is no audio graph yet.
  spectrum(out: Uint8Array): number {
    if (!this.analyser) return 0
    const bins = Math.min(out.length, this.analyser.frequencyBinCount)
    if (this.freqBuffer.length !== this.analyser.frequencyBinCount) {
      this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount)
    }
    this.analyser.getByteFrequencyData(this.freqBuffer)
    out.set(this.freqBuffer.subarray(0, bins))
    return bins
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise
    this.persistSessionId(true)
    this.destroyed = true
    this.wantsAudio = false
    this.backendActive = false
    this.sinkGeneration += 1

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer)
      this.suspendTimer = null
    }
    const sink = this.sink
    const pendingSink = this.sinkReady
    this.sink = null
    this.sinkReady = null
    sink?.dispose()

    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      ws.close()
    }

    this.pendingPcm = []
    this.makeup?.disconnect()
    this.limiter?.disconnect()
    this.ceiling?.disconnect()
    this.gain?.disconnect()
    this.analyser?.disconnect()
    this.makeup = null
    this.limiter = null
    this.ceiling = null
    this.gain = null
    this.analyser = null
    this.levelBuffer = new Uint8Array(0)
    this.freqBuffer = new Uint8Array(0)

    const ctx = this.ctx
    this.ctx = null
    const closeContext = ctx?.state === "closed" ? Promise.resolve() : ctx?.close()
    const disposeLateSink = pendingSink
      ?.then((lateSink) => {
        if (lateSink !== sink) lateSink.dispose()
      })
      .catch(() => {})

    this.destroyPromise = Promise.all([closeContext, disposeLateSink]).then(() => {})
    return this.destroyPromise
  }

  // --- audio graph ---

  private ensureContext(): AudioContext {
    if (this.destroyed) throw new SinkBuildCancelled("stream was destroyed")
    if (this.ctx) return this.ctx

    // ask for 48k to match the model; if the device refuses, the worklet's read
    // cursor resamples for free on its way out
    const ctx = new AudioContext({ sampleRate: this.sampleRate })

    const makeup = ctx.createGain()
    // The fixed makeup applies immediately: restoring the codec's known -6 dB
    // headroom is not something to converge toward over a minute.
    makeup.gain.value = dbToGain(MAKEUP_GAIN_DB)

    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -2.5
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.003
    limiter.release.value = 0.3

    // The compressor has a short look-ahead in browser implementations; this
    // final trim leaves another decibel for reconstruction/intersample peaks.
    const ceiling = ctx.createGain()
    ceiling.gain.value = dbToGain(-1)

    const gain = ctx.createGain()
    gain.gain.value = this.volume

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    // some smoothing, or the ring flickers a whole ring-step between frames -
    // but not much: the visualiser runs its own attack and release over these
    // numbers, and heavy smoothing here rounds the transients off before it
    // ever sees them
    analyser.smoothingTimeConstant = 0.55

    makeup.connect(limiter)
    limiter.connect(ceiling)
    ceiling.connect(gain)
    gain.connect(analyser)
    analyser.connect(ctx.destination)

    this.ctx = ctx
    this.makeup = makeup
    this.limiter = limiter
    this.ceiling = ceiling
    this.gain = gain
    this.analyser = analyser
    this.levelBuffer = new Uint8Array(analyser.fftSize)
    this.freqBuffer = new Uint8Array(analyser.frequencyBinCount)
    return ctx
  }

  private ensureSink(): Promise<PcmSink> {
    if (this.sinkReady) return this.sinkReady
    const generation = this.sinkGeneration
    const ready = this.buildSink(generation)
    this.sinkReady = ready
    void ready.catch(() => {
      if (this.sinkReady === ready) this.sinkReady = null
    })
    return ready
  }

  private async currentSink(): Promise<PcmSink | null> {
    while (!this.destroyed) {
      try {
        return await this.ensureSink()
      } catch (error) {
        if (!(error instanceof SinkBuildCancelled)) throw error
      }
    }
    return null
  }

  private async buildSink(generation: number): Promise<PcmSink> {
    const ctx = this.ensureContext()
    const reservoir = this.currentReservoir()
    const isCurrent = () =>
      !this.destroyed && generation === this.sinkGeneration && this.ctx === ctx

    let sink: PcmSink
    try {
      if (!ctx.audioWorklet) throw new Error("no AudioWorklet")
      await ctx.audioWorklet.addModule(WORKLET_URL)
      if (!isCurrent()) throw new SinkBuildCancelled("sink build was superseded")
      const node = new AudioWorkletNode(ctx, "mrt-pcm", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [this.channels],
        processorOptions: {
          channels: this.channels,
          sourceRate: this.sampleRate,
          ringSeconds: RING_SECONDS,
          ...reservoir,
        },
      })
      sink = new WorkletSink(
        node,
        (report) => this.onSinkReport(report),
        () => this.onStarved(),
      )
    } catch (error) {
      if (!isCurrent() || error instanceof SinkBuildCancelled) {
        throw new SinkBuildCancelled("sink build was superseded")
      }
      // no worklet here; chunk scheduling still makes sound
      sink = new TimerSink(
        ctx,
        this.channels,
        this.sampleRate,
        (report) => this.onSinkReport(report),
        () => this.onStarved(),
      )
      sink.configure(reservoir)
    }

    if (!isCurrent() || !this.makeup) {
      sink.dispose()
      throw new SinkBuildCancelled("sink build was superseded")
    }
    sink.output.connect(this.makeup)
    // Status may have arrived while the worklet module was compiling.
    sink.configure(this.currentReservoir())
    this.sink = sink
    for (const pcm of this.pendingPcm.splice(0)) sink.push(pcm)
    return sink
  }

  private async rebuildSink() {
    if (this.destroyed) return
    this.sinkGeneration += 1
    const oldSink = this.sink
    const oldReady = this.sinkReady
    oldSink?.dispose()
    this.sink = null
    this.sinkReady = null
    void oldReady
      ?.then((lateSink) => {
        if (lateSink !== oldSink) lateSink.dispose()
      })
      .catch(() => {})
    const sink = await this.currentSink()
    if (sink && !this.destroyed && this.wantsAudio) sink.play(true)
  }

  private onSinkReport(report: SinkReport) {
    if (!this.wantsAudio) return
    if (!this.backendActive) return
    this.load?.noteBuffer(report.playing, report.buffered, performance.now())
    this.persistSessionId()
    // Let the tuner recover while audio remains instead of waiting until the
    // listener hears a gap. Reports are frequent, so match the server's dwell.
    if (report.playing && report.buffered < 0.3) {
      const now = performance.now()
      if (now - this.lastPressureAt >= 4000) {
        this.lastPressureAt = now
        this.send({ type: "pressure" })
      }
    }
    if (report.playing) {
      this.patch({ status: "live", bufferProgress: 1 })
    } else {
      this.patch({
        status: "buffering",
        bufferProgress: report.need > 0 ? Math.min(1, report.buffered / report.need) : 0,
      })
    }
  }

  private currentReservoir(): Reservoir {
    const base = reservoirFor(this.realtimeFactor)
    return {
      ...base,
      prebufferSeconds: base.prebufferSeconds + this.recoveryMarginSeconds,
      rebufferSeconds: base.rebufferSeconds + this.recoveryMarginSeconds,
      comfortSeconds: base.comfortSeconds + this.recoveryMarginSeconds,
    }
  }

  private resetRecoveryMargin() {
    this.recoveryMarginSeconds = 0
    this.sink?.configure(this.currentReservoir())
  }

  private onStarved() {
    if (!this.wantsAudio || !this.backendActive || this.awaitingVariation) return
    // Learn only from audible underruns. Bounded recovery slack absorbs real
    // packet/render jitter without adding latency to a healthy first start.
    this.recoveryMarginSeconds = Math.min(
      MAX_GAP_MARGIN_SECONDS,
      this.recoveryMarginSeconds + GAP_MARGIN_SECONDS,
    )
    this.sink?.configure(this.currentReservoir())
    this.load?.noteUnderrun(performance.now())
    this.send({ type: "gap" })
  }

  private enqueue(pcm: ArrayBuffer) {
    if (this.awaitingVariation) return
    const sink = this.sink
    if (!sink) {
      // Normally the worklet is ready before the model's first second. Keep a
      // small bound for cold caches instead of dropping the beginning.
      if (this.pendingPcm.length >= 4) this.pendingPcm.shift()
      this.pendingPcm.push(pcm)
      return
    }

    // Also accept the final in-flight chunk after pause. The worklet retains
    // it silently, preserving sample continuity when playback resumes.
    sink.push(pcm)
  }

  // --- websocket ---

  private connect() {
    if (this.destroyed) return
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${protocol}//${backendHost()}/ws/session`)
    ws.binaryType = "arraybuffer"
    this.ws = ws
    this.patch({ status: "connecting", message: null })

    ws.onopen = () => {
      if (this.destroyed || this.ws !== ws) return
      this.reconnectDelay = 500
      this.requestedSessionId = readSessionId()
      this.send({
        type: "hello",
        sessionId: this.requestedSessionId,
        ...this.controls,
      })
      if (!this.wantsAudio) this.send({ type: "pause" })
    }

    ws.onmessage = (event) => {
      if (this.destroyed || this.ws !== ws) return
      if (event.data instanceof ArrayBuffer) {
        this.enqueue(event.data)
        return
      }
      this.handleControl(JSON.parse(event.data as string))
    }

    ws.onerror = () => {
      if (this.destroyed || this.ws !== ws) return
      this.patch({ status: "error", message: "lost the backend" })
    }

    ws.onclose = (event) => {
      if (this.destroyed || this.ws !== ws) return
      this.ws = null
      this.backendActive = false
      // The server restarts model state after every detached transport because
      // neither side can know how much in-flight PCM reached the speaker. Keep
      // the browser ring on the same boundary for all close codes, not only an
      // explicit backlog close.
      this.sink?.reset()
      this.pendingPcm = []
      if (FATAL_SERVER_CLOSE_CODES.has(event.code)) {
        this.wantsAudio = false
        this.activeSessionId = null
        clearSessionId()
        this.patch({
          status: "error",
          message:
            this.state.status === "error" && this.state.message
              ? this.state.message
              : event.reason || "the backend rejected this connection",
          bufferProgress: 0,
        })
        return
      }
      if (!this.wantsAudio) {
        this.patch({ status: "idle", bufferProgress: 0 })
        return
      }
      this.patch({ status: "connecting", message: "reconnecting" })
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        if (!this.destroyed) this.connect()
      }, this.reconnectDelay)
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000)
    }
  }

  private handleControl(message: Record<string, unknown>) {
    switch (message.type) {
      case "hello": {
        const id = typeof message.sessionId === "string" ? message.sessionId : ""
        const resumed = message.resumed === true
        if (!resumed || (this.activeSessionId && id !== this.activeSessionId)) {
          this.resetRecoveryMargin()
        }
        // Older servers reused a missing/expired ID for a newly seeded session.
        // Ask the upgraded server for a genuinely fresh identity if that stale
        // echo is ever observed.
        const staleEcho = !resumed && !!this.requestedSessionId && id === this.requestedSessionId
        if (staleEcho) {
          this.activeSessionId = null
          clearSessionId()
        } else {
          this.activeSessionId = id || null
          this.persistSessionId(true)
        }

        if (!resumed && this.sink) {
          // The backend could not continue the prior state (or this is the
          // first session). Fade/reset before accepting an unrelated stream.
          this.sink.reset()
          if (this.wantsAudio) this.sink.play(true)
        }

        // the sink is built before this arrives, from the format we assume the
        // backend uses. it always has so far - but a mismatch would play at the
        // wrong pitch and say nothing about it, so rebuild rather than trust it
        const rate = (message.sampleRate as number) ?? this.sampleRate
        const channels = (message.channels as number) ?? this.channels
        const moved = rate !== this.sampleRate || channels !== this.channels
        this.sampleRate = rate
        this.channels = channels
        if (moved && this.sink) void this.rebuildSink()

        if (staleEcho && this.ws?.readyState === WebSocket.OPEN) {
          this.awaitingVariation = true
          this.patch({ variationPending: true, status: "buffering", bufferProgress: 0 })
          this.send({ type: "variation" })
        } else if (this.awaitingVariation) {
          // A variation requested while the socket was still connecting became
          // a fresh null-session hello rather than an in-place reset.
          this.awaitingVariation = false
          this.patch({ variationPending: false })
        }
        this.requestedSessionId = null
        break
      }

      case "variation": {
        const id = typeof message.sessionId === "string" ? message.sessionId : ""
        this.activeSessionId = id || null
        this.persistSessionId(true)
        this.requestedSessionId = null
        this.awaitingVariation = false
        this.pendingPcm = []
        this.resetRecoveryMargin()
        this.sink?.reset()
        if (this.wantsAudio) this.sink?.play(true)
        this.patch({
          status: this.wantsAudio ? "buffering" : "paused",
          message: null,
          bufferProgress: 0,
          variationPending: false,
        })
        break
      }

      case "status": {
        const backendState = message.state as string
        const wasActive = this.backendActive
        this.backendActive = backendState === "active"
        const preserveGenerationError =
          this.state.status === "error" && !this.backendActive && !this.awaitingVariation

        const factor = message.realtimeFactor
        if (typeof factor === "number" && Number.isFinite(factor) && factor > 0) {
          // Even a small change can cross a reservoir policy boundary. Retain
          // the measured factor and the jitter margin on every valid update.
          this.realtimeFactor = factor
          this.sink?.configure(this.currentReservoir())
          this.load?.noteHealth(
            {
              realtimeFactor: factor,
              codebooks: typeof message.codebooks === "number" ? message.codebooks : undefined,
              maxCodebooks:
                typeof message.maxCodebooks === "number" ? message.maxCodebooks : undefined,
            },
            performance.now(),
          )
        }

        if (this.backendActive && !wasActive && this.wantsAudio) {
          // A freshly playing bank naturally dips while the next chunk renders.
          // Give that sawtooth a full feedback interval before
          // treating low water as sustained pressure.
          this.lastPressureAt = performance.now()
          this.sink?.play(true)
        }

        let status: StreamStatus
        if (preserveGenerationError) {
          status = "error"
        } else if (this.awaitingVariation) {
          status = "buffering"
        } else if (this.backendActive) {
          // the backend is generating for us; what the listener hears depends
          // on whether we have banked enough to play
          status = !this.wantsAudio
            ? "paused"
            : this.state.status === "live"
              ? "live"
              : "buffering"
        } else if (backendState === "queued") {
          status = "queued"
        } else if (backendState === "loading") {
          status = "loading"
        } else {
          status = "paused"
        }

        this.patch({
          status,
          queuePosition: (message.position as number) ?? 0,
          listeners: (message.listeners as number) ?? 0,
          capacity: (message.capacity as number) ?? 0,
          message: preserveGenerationError
            ? this.state.message
            : ((message.error as string) ?? null),
        })
        break
      }

      case "error": {
        this.wantsAudio = false
        this.backendActive = false
        this.awaitingVariation = false
        this.pendingPcm = []
        this.sink?.reset()
        this.patch({
          status: "error",
          message: message.message as string,
          variationPending: false,
        })
        break
      }
    }
  }

  private send(payload: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }

  private persistSessionId(force = false) {
    if (!this.activeSessionId) return
    const now = Date.now()
    if (!force && now - this.lastSessionPersistedAt < 60_000) return
    writeSessionId(this.activeSessionId)
    this.lastSessionPersistedAt = now
  }

  private patch(next: Partial<StreamState>) {
    if (this.destroyed) return
    // the sink reports about twelve times a second, and every one of these used
    // to re-render the whole page. once the stream is live nothing in here
    // moves, so an unchanged state is not worth waking react for.
    const merged = { ...this.state, ...next }
    merged.bufferProgress = Math.round(merged.bufferProgress * 50) / 50
    const current = this.state
    if (
      merged.status === current.status &&
      merged.queuePosition === current.queuePosition &&
      merged.listeners === current.listeners &&
      merged.capacity === current.capacity &&
      merged.message === current.message &&
      merged.bufferProgress === current.bufferProgress &&
      merged.variationPending === current.variationPending
    ) {
      return
    }
    this.state = merged
    this.onState(merged)
  }
}
