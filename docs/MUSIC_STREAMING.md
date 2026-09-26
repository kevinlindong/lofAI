# Music streaming design

This document records how Magenta RealTime 2 (MRT2) works, how lofAI uses it,
and why the live path is intentionally small. The implementation is pinned to
`magenta-rt[mlx]` 2.0.3; upstream behavior described here was checked against
that release and Google's current model/core documentation.

## MRT2 in one frame

MRT2 is a streaming codec language model, not a prompt-to-song renderer. Every
40 ms it repeats this causal loop:

1. MusicCoCa supplies 12 style tokens from a 768-dimensional text/audio
   embedding. lofAI caches this work until the style changes.
2. Optional MIDI supplies the current state of 128 pitches; an optional drum
   token supplies a coarse drum condition.
3. A decoder-only Transformer reads those controls plus its recurrent audio
   history and samples up to 12 SpectroStream audio tokens.
4. SpectroStream decodes the tokens to 1,920 samples of 48 kHz stereo PCM.
5. The new state becomes the context for the next frame.

The small model has 230M parameters. Its local sliding-window attention gives
it an effective context of roughly 20 seconds even though each layer attends to
a shorter window. Controls are frame-aligned, but end-to-end response includes
inference, codec, host, and playback buffering; Google's reference figure is
about 200 ms.

Primary references:

- [MRT2 technical announcement](https://magenta.withgoogle.com/magenta-realtime-2)
- [Official model card](https://github.com/magenta/magenta-realtime/blob/main/MODEL.md)
- [Official repository](https://github.com/magenta/magenta-realtime)
- [Official C++ streaming core](https://github.com/magenta/magenta-realtime/blob/main/core/README.md)

## lofAI's live data path

```text
station / drums / volume
          |
          v
WebSocket control -> Session -> style embedding + recurrent MRT2 state
                                  |
                                  v
                           one MLX worker
                                  |
                         320 ms first PCM burst
                         400 ms steady bursts
                                  |
                                  v
bounded server outbox -> WebSocket -> 8 s AudioWorklet ring
                                      |
                                ~0.6-0.9 s start bank
                                      |
                         fixed makeup -> limiter -> speakers
```

There is one loaded model and one MLX-owning worker thread. Each listener keeps
only its own recurrent model state, prompt transition, transport clock, and
seed. The normal live conditioning is:

- all twelve MusicCoCa style tokens from one curated station prompt. Neither
  checkpoint was trained with style-token masking (`mask_musiccoca=False`),
  so masking the fine half at inference conditions the model outside its
  training distribution; the earlier six-token mask audibly weakened style
  adherence and is now an explicit experiment behind
  `MRT_STYLE_TOKEN_LEVELS`;
- no piano-roll tokens, so MRT2 performs and continues its own music;
- no drum condition when drums are enabled, or an explicit off token when they
  are disabled;
- sampling: temperature 1.0, top-k 100, MusicCoCa CFG 3, drums CFG 1, and
  notes CFG 1 (the library default). The earlier notes CFG of 5 told the
  model, every frame, to strongly follow a fully masked score - a token
  combination it never saw in training, since the notes CFG token co-varied
  with real piano-roll data. Raise it only when actually supplying notes.

The older 32-bar symbolic composer remains in `composition.py` and `melody.py`
for offline, fixed-seed listening comparisons. It is not part of `Session` or
the real-time hot loop.

### Component responsibilities

| Component | One job in the live path |
|---|---|
| `frontend/components/music-controls.tsx` | Select a curated station, drums on/off, local volume, or a new take |
| `frontend/lib/mrt-stream.ts` | Own the WebSocket session, choose a small reservoir, and build the output/mastering graph |
| `frontend/public/mrt-pcm-worklet.js` | Consume interleaved PCM through one bounded ring and continuous audio-thread cursor |
| `backend/server.py` | Validate messages and bridge PCM through a bounded per-socket outbox |
| `backend/session_manager.py` | Admit one live listener on this machine, pace chunks, and own the sole model thread |
| `backend/session.py` | Hold one recurrent state/seed, turn station changes into short style ramps, and keep the take's clean-anchor memory |
| `backend/take_health.py` | Watch each take's quiet-moment floor: an early `rising` signal, the sustained `drifted` backstop, and which stretches are clean enough to remember; provide the crossfade splice |
| `backend/engine.py` | Load MRT2, cache conditioning, render frames, measure speed, and tune codec depth |
| `backend/fast_engine.py` | Specialize the pinned magenta-rt streaming step: sliced logits, cached conditioning encoding, hoisted constants, clean RVQ truncation |
| `backend/compiled_engine.py` | Render a chunk as tokens first, then one batched codec call; trace both halves with `mx.compile`; keep session state detached from chunk activations; teacher-force a standby state through known tokens (`_Primer`) |
| `backend/hiss_filter.py` | Remove the stationary hiss floor, whistles, and high ringing from each delivered stream |
| `backend/style_embedder.py` | Embed new custom prompts in a short-lived child process so the model thread never waits on MusicCoCa |
| `frontend/lib/render-budget.ts` | Switch the page to low-power rendering when the backend reports it is short of headroom |
| `backend/style_tokens.py` | NumPy replica of MusicCoCa's RVQ tokenizer, verified against TFLite, so the interpreters can be released after startup |
| `backend/styles.py` | Define the four listener-facing MusicCoCa prompts and optional audio references |

`composition.py`, `melody.py`, and `backend/evaluation/` are deliberately
outside that table: they support offline listening experiments, not playback.

## What made the previous stream slow

### September 2026: where a frame actually went

A stage-by-stage measurement of one 12-codebook frame on an M3 Pro (18 GB,
8-bit weights, barrier after each stage) corrected the earlier picture:

| Stage | ms | Note |
|---|---:|---|
| Conditioning encoder | 0.2 | cached per block |
| Temporal body (12 layers, 1024-d) | 4.9 | about 200 MB of weight reads |
| Depth loop (12 sequential steps) | 6.6 | 14.8 with a barrier after every step, which is how the earlier profile attributed "14 of 24 ms" here |
| SpectroStream codec, one frame | 10.3 | 143 MB of float32 Conv2D plus the iSTFT, run at T = 1 |
| Python graph construction | 5.6 | on the critical path; `async_eval` hides only part of it |

Two findings drove the changes. First, `nn.quantize` never touches the
codec: it converts `nn.Linear`/`nn.Embedding` and the attention modules'
own `to_quantized` hooks, so the 143 MB conv decoder and the 67 MB RVQ table
stay float32 and are read in full every 40 ms. Per-frame weight traffic is
roughly 540 MB, which on an M1's ~68 GB/s is an ~8 ms floor before any
kernel launch or Python overhead. Second, the codec - not the depth loop -
was the largest single stage.

**Batched codec.** The codec is causal convolution, not autoregression: its
`step` over a ten-frame token sequence yields the same samples as ten
single-frame steps (measured: 1 LSB over 600k samples), at 2.9 instead of
10.0 ms per frame. `compiled_engine.ChunkRenderer` therefore samples every
frame's tokens first and decodes the chunk in one call. Latency is
unchanged: `generate()` already returned whole chunks. The one trap was
memory: the codec's returned streaming state consists of slices into the
chunk's activations, and MLX slices share their donor buffer, so a naive
version pinned about a gigabyte per listener between chunks. State leaves
are now copied out with `mx.contiguous` before they leave the renderer, and
the flatten/rebuild helpers avoid self-referential closures, which had been
holding those same views hostage to the cyclic garbage collector.

**Compiled step.** The sampling half of the specialized step (the encoder
runs once per block outside the trace) and the batched codec are traced
with `mx.compile`, with sequence_layers' `Sequence`-bearing state flattened
to arrays at the boundary. Python time per depthformer frame fell from 4.3
to 0.55 ms and the step from 12.5 to 7.2 ms; fused kernels, not just less
Python. The active codebook count is Python control flow inside the step, so
one trace is kept per count, and every live chunk length is traced during
calibration (`prewarm`, about 0.6 s for three counts at two lengths).
Compiled output is not bit-identical: from an identical state, compiled and
eager tokens differed in 10 of 60 single steps, all in the flat-distribution
deep codebooks, with a total variation distance of about 0.03 on the
sampling distribution and the same argmax and top-5. The already-shipped
sliced-logits step differs from the stock library in 30 of 30 frames, so
this is the same class of trade. `MRT_COMPILE=0` restores the eager step.

Combined, on the M3 Pro at 12 codebooks: 18.8 → 8.5 ms per frame (2.2x),
with the codebook dial now worth about 0.3 ms per step. The M1 Air was not
available for measurement; both changes attack costs that scale with memory
bandwidth and CPU speed, which the M1 has less of, so the relative gain
should be at least as large there. Casting the codec to fp16/bf16 was also
tried and dropped: 0.7 ms per frame at best, and the conv decoder's output
did not survive the cast cleanly.

**Memory.** The MusicCoCa TFLite interpreters (text encoder, mapper,
quantizer) stayed resident for the life of the process - about 900 MB on a
cold start - and JAX is imported by the vendored `sequence_layers.mlx`
(~230 MB). The RVQ quantizer graph turned out to be a plain 12-level
residual nearest-neighbour search; `style_tokens.py` extracts its codebooks,
verifies its own tokens against the interpreter on random vectors, the
station embeddings, and their ramp blends (956 of 956 agreed locally), and
caches them next to the embeddings. With tokenization native, the engine
releases every interpreter after warm-up; they rebuild lazily if an unknown
prompt arrives. The MLX buffer cache limit is applied from the first
allocation rather than after calibration, which removed a 1.5-3 GB startup
transient. Cold start settled at about 1.0 GB resident versus 1.7 GB before;
the JAX import remains, since `sequence_layers.mlx` uses it for its config
base classes.

### September 2026 audit of the installed runtime

The optimized step was configured on but failed during installation:
`inspect.signature(mx.quantized_matmul)` raises `TypeError` on MLX 0.32.2's
native nanobind function. The exception sent generation back to the stock
step, disabling sliced projections, cached conditioning, and hoisted constants.
The projector now reads the quantization mode from `QuantizedLinear`, matching
the installed layer's own call. This enables the existing optimization on the
actual pinned runtime rather than relying on its configuration flag.

SpectroStream also rebuilt its constant inverse-STFT synthesis window with
GPU operations and copied it to NumPy inside every frame. That readback
synchronized the pipeline. Caching the original window once removes the
repeated calculation and synchronization without changing its values.

Two forward/reverse-order local comparisons on the 8 GB M1 used the small
model, 8-bit weights, all 12 codebooks, 10-frame paced calls, GPU keepalive,
and the 384 MB MLX cache cap. Each variant rendered 150 frames, excluding
30 warmup frames from timing:

| Configuration | Mean ms/frame, run 1 | Mean ms/frame, run 2 |
|---|---:|---:|
| Previous deployed fallback | 41.65 | 39.02 |
| Enabled specialized step | 36.84 | 36.38 |
| Specialized step + cached window | 36.20 | 36.29 |

The combined average fell from 40.33 to 36.25 ms/frame (about 10% less render
time, approximately 0.99x to 1.10x real time at full depth). The cached-window
and uncached-specialized paths produced identical six-second seeded PCM in
both comparisons. MLX active allocations were about 450 MB and reusable cache
about 239 MB; these are MLX measurements, not total application memory or
energy use. Host load and swap pressure affected timings. Adaptive 10–12
codebooks remain enabled to obtain additional margin when full depth cannot
meet the 1.18x target. An experimental compiled sampler was not retained:
its smaller additional improvement was inconsistent.

The old speed meter also used the median chunk cost. With two 30 ms frames
and one 200 ms frame it reported 1.33x, even though total throughput was only
0.46x. The meter now divides total generated audio by total rendering time,
weighted correctly for unequal chunk sizes. The tuner can ignore one worst
chunk to preserve quality through isolated jitter, but a deficit that remains
for six seconds still causes a depth reduction. Admission and browser reservoir
selection use the untrimmed measured throughput.

An integrated 180-second source-audio capture then reproduced six simulated
playback underruns on this host. Live inference RTF ranged from 0.705 to 1.188
(median 1.108), despite the improved mean benchmark. Unpaused packet intervals
reached 1.025 seconds. This exposed a separate client bug: its 0.05 RTF update
deadband ignored a 1.203-to-1.157 change even though it crossed the 1.18 buffer
policy boundary. Valid speed updates now always refresh the policy, and the
server broadcasts speed every four seconds even when depth stays at its floor.
Each audible underrun adds 0.2 seconds of recovery margin, capped at 0.8 extra
seconds; the margin survives pauses and resets for a new take/session.

Replaying the same packet arrivals with recorded periodic health measurements
and the new bounded margin reduced interruptions from six to three. Total
refill waits were 5.92 seconds versus 5.32 seconds: fewer, longer recoveries.
Initial startup stayed unchanged and peak retained audio was 2.013 seconds.
This is a fixed-trace simulation, not a second live performance or a guarantee
of uninterrupted audio. A slower initial start did not reduce interruptions
on that trace, so the initial reservoir defaults remain unchanged. No finite
reservoir fixes sustained generation below 1x at the configured quality floor.

A subsequent live 90-second capture verified periodic status, a station change,
pause/resume, and the new margin cap. With heavier concurrent host activity,
median reported render RTF was 0.975 at the 10-layer floor, unpaused packet
intervals reached 1.637 seconds, and five simulated underruns required 13.57
seconds of refill waits. Peak buffering remained bounded at 2.413 seconds.
The server shut down cleanly after both captures. The new buffer policy cannot
promise uninterrupted playback when the host cannot supply frames fast enough;
the two live captures are not controlled before/after speed comparisons.

Those checks exposed a scheduling mismatch: tool-launched Python's main
thread had macOS user-interactive QoS, while a newly created Python worker
had default QoS. A final paired comparison ran on a dedicated Python worker
at 8-bit / 10 codebooks, alternating default and user-initiated QoS:

| Worker priority | Forward mean ms/frame | Reverse mean ms/frame |
|---|---:|---:|
| Default | 39.88 | 52.63 |
| User initiated | 37.97 | 39.85 |

All four seeded 4.8-second outputs were identical. User-initiated was faster
in both pairs, but the large final default-thread stall makes the aggregate
15.9% improvement noisy. This effect must not be added to the earlier 10%
figure or treated as an assurance of real-time performance under every load.
The dedicated inference worker now requests user-initiated QoS before loading
MLX, using Apple's supported per-thread API. Higher existing priority is
preserved, failure falls back safely, and no other app's priority is changed.
`MRT_WORKER_QOS=default` opts out; `/health` exposes `workerQoS`. This follows
[Apple's guidance for work needed for an immediate user action](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/EnergyGuide-iOS/PrioritizeWorkWithQoS.html).
The long live captures above preceded this scheduling change; the paired
worker benchmark and regression tests validate it separately.

The observations and tables below predate this audit and describe earlier
configurations, not guaranteed throughput under the current machine load.

The observed startup calibration was 71.8 ms per 40 ms frame, or 0.56x real
time. A six-second prebuffer can hide that deficit for only about 14 seconds:
the reservoir loses 0.44 seconds every second. Rebuffering was therefore the
expected steady state, not a browser scheduling accident.

Several design choices compounded it:

- Eight-bit eager inference left too little margin on this 8 GB M1 Air.
- One-second first chunks and a two-second server lead made playback and every
  control feel late.
- The browser responded to a sub-real-time producer by banking up to six
  seconds, which postponed rather than solved the next gap.
- Every frame received a generated 128-note piano roll and score clock. That
  added planning and conditioning churn and made the small model sound rigid,
  because the external score competed with its learned audio continuation.
- Nine hidden legacy prompt combinations were embedded during startup even
  though the UI exposed four stations.
- Sampling values differed substantially from the reference live engine,
  especially drum CFG 4 instead of 1.
- Bursty eager inference lets macOS downclock the GPU between calls. Google's
  `RealtimeRunner` explicitly issues tiny GPU operations while its ring is
  full to avoid this.
- The browser and server retained 45 and 30 seconds of audio respectively,
  allowing large amounts of stale music to accumulate without improving
  sustainable throughput.

## Changes and measured tradeoffs

All measurements below were made locally on the target M1 Air with the
`mrt2_small` checkpoint. Real-time factor is seconds of audio generated per
wall-clock second; it must remain above 1.0 indefinitely.

| Eager configuration | ms/frame | real-time factor |
|---|---:|---:|
| 8-bit, 12 codec layers | 37.8 | 1.06x |
| 8-bit, 10 codec layers | 35.4 | 1.13x |
| 8-bit, 8 codec layers | 33.7 | 1.19x |
| 4-bit, 12 codec layers | 35.1 | 1.14x |
| 4-bit, 10 codec layers | 33.1 | 1.21x |

Four-bit weights also reduced model load from roughly 13.4 to 6.1-6.5 seconds
in repeated local runs. Four-bit was originally chosen as the live default on
those numbers alone. It was later reverted to 8-bit: `nn.quantize` was
quantizing the *entire* sampler with round-to-nearest 4-bit weights -
including the SpectroStream codec decoder that turns tokens into waveforms
and every embedding table - and that was audibly the largest quality cost in
the pipeline. The specialized step loop below buys back more time than the
4-bit/8-bit gap, so the speed argument for 4-bit no longer holds. When
`MRT_BITS=4` is explicitly requested for memory, the codec decoder now stays
at 8-bit: degraded token prediction is a taste choice, a degraded codec is
just noise. Codec depth remains adaptive from 12 down to a quality floor of
10, and calibration targets 1.18x.

## The specialized streaming step

Profiling the per-frame step on an M3 Pro (barriered, so relative numbers
only) attributed roughly 14 of 24 ms to the depth loop: 10-12 sequential
two-layer transformer steps, each ending in a `to_logits` projection of its
768-dim hidden state onto the full 12,294-token vocabulary, of which exactly
1,024 logits are valid for that codebook. `backend/fast_engine.py` replaces
the pinned library step (per instance, guarded by version and structure
checks, with per-call fallback to stock) with one that:

- projects each depth step against only its codebook's 1,024 weight rows,
  reading 12x less `to_logits` weight data per step. Metal tiles the smaller
  matmul differently, so logits may differ from stock in the final bf16
  mantissa bit; install-time verification requires agreement within one ulp
  and disables slicing otherwise. Takes can therefore diverge from the stock
  trajectory over time, the same documented trade the fast sampler already
  makes with its RNG stream;
- computes the conditioning encoder once per conditioning block instead of
  every frame (the encoder is stateless in this configuration, so this is
  exactly equal);
- hoists the depth transformer's initial state, the skipped-codebook dummy
  tokens, and the CFG/delay bookkeeping the live path never uses out of the
  per-frame loop (exactly equal).

It also fixes what quality truncation actually decodes. Upstream pads
skipped codebooks with code 0 and the RVQ decode then adds that codebook's
row-0 *centroid* - a full-magnitude learned vector, not silence - into every
frame (measured `|q10[0]| = 6.24` against a codebook mean of `6.23`). At 10
active layers that contaminated every frame of audio with two arbitrary
residual vectors, which is a large part of why reduced depth sounded broken
rather than merely duller. The decode now slices the token frame to the
active count, making truncation mean truncation. At 12 active layers both
paths are identical.

Measured on an M3 Pro at 12 codec layers, 10-frame chunks, in the pipelined
engine loop (medians over 250 frames): 8-bit stock+fast-sampler 20.1
ms/frame (1.99x) against 19.0 ms/frame (2.11x) with the fast engine, and the
same take stayed bit-identical end to end. At 10 active layers the gap was
19.6 against 18.0 ms/frame, where output intentionally differs because the
code-0 contamination is gone. The absolute win is larger on
bandwidth-constrained machines like the target M1 Air, where the full
`to_logits` read alone costs roughly 1.9 ms per frame at 8 bits versus
roughly 0.16 ms sliced.

## Long takes: the rising noise floor

Two separate mechanisms made long sessions grow an audible hiss bed, one on
each side of the WebSocket, and they compounded.

**The model amplifies its own floor.** MRT2's only continuity is the audio
it just generated. On sparse stations that feedback has a failure
attractor: once a bright sustained texture enters the ~20-second context,
the model tends to continue and reinforce it. Rendered 12-minute takes,
measured on the level of the quietest 50 ms blocks (the gaps between notes,
where a bed is exposed) against the same take's first minute:

| Station | quiet-gap floor early | worst trailing minute | high band (5-14 kHz) |
|---|---:|---:|---:|
| rainy-piano | -42.7 dBFS | +9.9 dB | +28 dB |
| dusty-beats (12 min) | -45.3 dBFS | +19.4 dB | +23 dB |
| jazz-cafe | -37.8 dBFS | +6.6 dB, receded | +12 dB, receded |

The first two are runaways: the floor climbs for minutes and does not come
back. The jazz excursion is what a healthy arrangement getting brighter for
half a minute looks like, and it recovers on its own.

`backend/take_health.py` watches exactly this measurement on the PCM each
listener actually receives. A baseline floor profile is frozen over the
take's first 40 seconds (after a 10-second landing period); the high band
(5-20 kHz) of the trailing 30 seconds' floor must then rise at least 10 dB
over its own baseline and reach -60 dBFS, in at least 80% of evaluations
across a 30-second audio window, before the take is declared drifted. A
second, baseline-free test declares drift when that floor reaches -38 dBFS
outright, so a take whose baseline was itself learned from hiss still gets
cut. The decision is deliberately spectral: a live-captured failure grew
+22 dB of high-band hiss while its overall floor rose only +1 dB - the bed
brightens long before it lifts - while a warm rumble or denser bass never
qualifies. Level and spectrum are measured on the same quietest-decile
blocks, so louder or denser playing does not qualify either - only the bed
under it. The repair is a server-side equal-power crossfade onto a fresh
recurrent state under the same conditioning (one extra chunk of render
cost, deterministic refresh seed, no transport or session change): a subtle
track change instead of a slowly degrading stream. Station changes re-learn
the baseline, since the recurrent state - and any drift it carries -
survives them; if the floor was already voting for drift when the station
changed, the worker splices onto a fresh state at that boundary rather than
letting the next station learn the hiss as its normal. `MRT_TAKE_GUARD=0`
disables the guard.

A later re-measurement found the first calibration too cautious to help.
Nine takes of 4-10 minutes were rendered offline through the live engine
path (`ChunkRenderer`, compiled step, batched codec, 12 codebooks) and
replayed through the monitor:

| Take | 5-20 kHz quiet-block floor, start → worst | first guard fire |
|---|---:|---:|
| rainy-piano, drums (seed 1234) | -69 → -55 dBFS at 2.6 min | 2.7 min |
| rainy-piano, drums, `MRT_COMPILE=0` | -68 → -50 dBFS at 2.9 min | 2.2 min |
| rainy-piano, no drums (seed 777) | -69 → -50 dBFS at 4.2 min | 4.2 min |
| rainy-piano, no drums, `MRT_TEMPERATURE=0.9` | -72 → -37 dBFS at 9.4 min | 3.0 min |
| rainy-piano, no drums, `MRT_BITS=0` | -70 → -55 dBFS at 8.8 min | 8.8 min |
| dusty-beats, drums | -67 → -41 dBFS at 6.8 min | 5.1 min |
| jazz-cafe, drums (seed 99) | -54 → -40 dBFS at 7.0 min | 5.5 min |
| jazz-cafe, drums (seed 4242) | -54 → -44 dBFS, receded | never |
| sunlit-groove, drums | -51 → -45 dBFS, receded | never |

Every configuration drifted, so the habit belongs to the model rather than
to compilation, batching, quantisation, or the sampling temperature. Two
textures appeared. Sparse stations grew broadband 3-13 kHz hiss in their
gaps, with a persistent tone near 5 kHz on the way. Busy stations grew a
14-20 kHz bed under the music: the dusty-beats take's stationary 14-20 kHz
level climbed monotonically from -87 to -41 dBFS over six minutes while its
5-10 kHz band never moved, which the earlier 5-14 kHz band could not see at
all. Under the earlier constants (60-second baseline and trailing windows,
40-second sustain, -52 dBFS audibility gate, 5-14 kHz) the seed-777 take
never fired in ten minutes: its floor sat at -55 to -60 dBFS - audible
hiss after the client's +5 dB makeup - for four minutes below the gate. The
worst take reached -35 dBFS with two thirds of its quiet-block energy above
5 kHz, which is the "static that gets louder until the music is
unlistenable" listeners reported. The current constants fire on all seven
runaways between 2.2 and 5.5 minutes (8.8 for the full-precision take,
whose drift began late) and on neither healthy take; the closest healthy
excursion, a brushed passage on jazz-cafe, reached +9.8 dB over its
baseline for about a minute.

Because drift accumulates with age while healthy brightening happens early
(an arrangement still building), the sustain requirement scales with take
age: a take under `MATURE_TAKE_SECONDS` (150 s) must hold a
`HIGH_BAND_RISE_DB` (10 dB) rise for `SUSTAIN_SECONDS` (30 s), while an
older one is cut after `MATURE_SUSTAIN_SECONDS` (10 s) of a smaller
`MATURE_RISE_DB` (8 dB). On the captured takes this pulled each runaway's
first cut earlier - the seed-777 no-drums take from 253 s to 230 s,
jazz-cafe from 329 s to 158 s - without adding a fire on either healthy
take.

**Stronger conditioning is the primary fix; the guard is the backstop.**
The guard is reactive: it must watch the floor rise for tens of seconds
before it cuts, so every crossfade still lets some hiss through first.
Re-measuring the sparse case against MusicCoCa guidance strength found a
better lever. At the library's live default of `MRT_CFG_MUSICCOCA` 3.0 the
rainy-piano no-drums take ran to -33 to -42 dBFS in band on every seed;
at 4.0 the same seeds peaked near -60 dBFS and receded to -74 dBFS instead
of running away, with quiet-block high-band share staying under about 6%,
and at 5.0 they never rose above -53 dBFS. The prompt matters too, in the
opposite direction from intuition: appending "clean quiet recording" to
the rainy-piano prompt made it hiss *faster* (83% high-band share by 2.7
minutes), because those tokens pull MusicCoCa toward recording noise.
Busy stations (dusty-beats, jazz-cafe) were already stable at 3.0 and
stayed stable at 4.0. CFG is encoded as conditioning tokens on the live
path, so a higher scale costs no throughput. The default is now 4.0.
Combined with the guard, a 10-minute rainy-piano no-drums take that
previously reached -33 dBFS of static now holds a -54 to -74 dBFS
high-band floor, the guard trimming it back to -74 dBFS two or three times
across the take rather than letting it run away.

The September audit found that folding PCM to mono before measuring it hid
opposite-phase stereo hiss. The monitor now averages channel powers instead,
and evaluates every 400 ms of audio rather than once per incoming chunk.
Chunk size and empty calls therefore cannot shorten or lengthen the sustain
window. Small remainder buffers own their memory, and percentile selection
uses partitioning instead of sorting. Synthetic tests reproduce both bugs;
monitor overhead remains about 0.34 ms per 400 ms chunk on the local M1.
The guard needs an early baseline: it does not remove hiss already present
from the beginning or guarantee detection after a noisy style-change baseline.
The affected station prompts no longer explicitly ask for vinyl or tape.

**The client mastering chased dynamics.** The old loudness normalizer
adapted over a +9 dB range fast enough to follow musical passages: every
mellow stretch ratcheted the gain up - exactly when a floor is most
audible - and the codec noise floor rose with it, up to +6.9 dB in
simulation over a real take. A later ±3 dB trim still reached its maximum
in about 15 seconds on quiet audio. The current graph removes that adaptive
trim, its extra 32,768-sample analyser and its polling timer altogether.
A fixed +5 dB makeup stage compensates for most of the codec's -6 dB int16
headroom; the existing limiter, output ceiling, and listener volume remain.
Music and any inherent noise are amplified equally by that fixed amount,
without a gain increase as the take becomes quiet.

The worklet now retains incoming new-take PCM while the previous take fades
out, honors a pause during that transition, and fades at a ring overflow
instead of silently omitting a packet and splicing later audio across the hole.
At 48 kHz and unity playback speed, it reads each PCM sample directly instead
of interpolating with a second ring read. Resampling retains one continuous
fractional cursor when source and device rates differ.
In a synthetic native-rate worklet benchmark, 80 seconds of stereo audio took
28.4 ms of processing versus 314.6 ms before (five-run medians). This is the
isolated DSP loop, not an estimate of overall app CPU or model speed. The
timer-based compatibility sink also preserves its queued scheduling cursor
across a pause so new chunks cannot overlap already scheduled audio.

Batching still matters for the eager Python runtime:

| Frames per call | Audio duration | observed factor at 4-bit / 10 layers |
|---:|---:|---:|
| 1 | 40 ms | 0.97x |
| 3 | 120 ms | 1.09x |
| 10 | 400 ms | 1.16x |
| 25 | 1,000 ms | 1.20x |

Ten steady-state frames retain enough batching benefit while capping
server-side control granularity at 400 ms. A new take starts with eight frames
so its first 320 ms of audio arrives before the steady batch. The browser starts
after roughly 0.64-0.9 seconds when the renderer is
healthy, keeps playback at exactly 1.0x, and reports pressure early enough for
the backend to reduce one codec layer. It never tries to disguise a sustained
sub-real-time renderer with an ever-growing delay.

An end-to-end WebSocket check of the final defaults produced 10.32 seconds of
PCM in 10.15 seconds of wall time. First PCM arrived in 294 ms, the simulated
browser crossed its playback bank at 616 ms, the largest packet interval was
412 ms, and the reservoir never emptied. The engine held 11 codec layers at
1.20x measured render speed. A separate 30-second run with two station changes
and a drum change produced 30.3 seconds of audio in 30.2 seconds, held roughly
1.17x render speed, and likewise kept the simulated reservoir above zero.

## Long takes, second pass: re-priming from clean memory

The guard above is reactive, and a listener still heard the static. This pass
re-measured the problem offline on the live path (`ChunkRenderer`, compiled
step, batched codec) with 8-minute renders, reporting the 5-20 kHz level of
each 30-second window's quietest decile of 50 ms blocks.

**It is the model, not this pipeline.** The stock library step (no fast
engine, no fast sampler, no compile, per-frame codec) drifted too: -67 to
-51 dBFS by 1.5 minutes on rainy-piano. Three implementation suspects were
ruled out directly. MRT2 has no positional encoding at all (NoPE,
`use_rope=False`), and `mx.fast.rope` would hold bf16-level error out to
90,000 frames anyway. The load-time warning about
`decoder.embedder.layers.1._scale` is the constant sqrt(d_model) embedding
scale, not a trained weight. The codec is a finite-receptive-field causal
decoder with no recurrent state to accumulate. Upstream's C++ runner has no
runtime counter-measure either; its design note credits attention sinks with
suppressing "ringing and feedback" in long generation, which is the failure
seen here.

**What the bed is.** On the 10-codebook runaway the quiet-block spectrum grew
a stationary 8-15.5 kHz hump about 25 dB above the take's opening, present
under the music as well as between notes. Other takes grew narrow whistles
(3.3 and 5.25 kHz; 10.0, 11.9 and 13.7 kHz) that are re-excited with the
music rather than stationary. Fewer codebooks drift sooner: the same take
reached -42 dBFS at 2.5 minutes with 10 codebooks against 6.5 minutes with 12,
so a machine the tuner holds at its floor is also the one that hisses first.

**What did not work.**

| Attempt | Result |
|---|---|
| Cooler sampling for deep RVQ levels (x1.0 down to x0.6) | still reached -38 to -40 dBFS |
| Mean embedding instead of code 0 for skipped levels in the history | marginal delay, same runaway |
| Output-stage noise suppression (minimum statistics, relative to the take's own baseline) | transparent on clean audio, but only 4-6 dB off the hump and nothing off the whistles |
| Denoise the last 20 s, re-encode with the SpectroStream encoder, prime a fresh state | the runaway held near -53 to -58 dBFS instead of -42, but content above 10 kHz fell below the take's own opening |

**What works: continuing from clean memory.** A fresh state teacher-forced
through the take's *own sampled tokens* from a verified-clean stretch is the
state the model had after playing that stretch, so it continues the same
music with no hiss in its memory. Re-priming every 48 seconds from the take's
opening held the floor flat for the whole render:

| Take | Unguarded | Re-primed from its clean opening |
|---|---:|---:|
| rainy-piano, no drums, 10 codebooks | -72 to -42 dBFS by 2.5 min, then -55 to -59 | -65 to -71 throughout |
| rainy-piano, no drums, 12 codebooks | -68 to -42/-50 from 2 min | -62 to -68 throughout |

Priming needs no depth loop and no codec - only the temporal transformer, so
it runs compiled at 2.5-3 ms per frame on the M3 Pro (about 1.2-1.5 s for the
490 frames that fill mrt2_small's ~19.7 s receptive field). Batched
(multi-frame) temporal steps do not reproduce frame-by-frame state in
sequence_layers, so it is sequential.

The live policy (`session_manager._guard_take`):

- `Session` records each chunk's sampled frames. Whenever the most recent
  19.6 s under one unchanged conditioning has a quiet-block high band within
  3 dB of the take's baseline and below -62 dBFS, it joins a pool of the four
  cleanest such anchors. A re-prime uses the cleanest, preferring the most
  recent among those within 1.5 dB of it. Anchors taken from the latest clean
  stretch alone re-drifted within half a minute; the cleanest held.
- `TakeFloorMonitor.rising` - a 6 dB rise over the baseline, at least
  -66 dBFS, held for 10 seconds - starts priming a standby state. The worker
  advances it only while no stream is due, in slices sized from the measured
  per-frame cost to finish before the next chunk is, so no listener waits for
  it; on a machine with no slack it simply does not progress. When it is ready the next chunk is rendered from both states
  and crossfaded; the monitor keeps its baseline and restarts its trailing
  window. If the floor settled while the standby was prepared, the standby is
  dropped instead of jumping.
- A floor that keeps coming back backs the re-primes off (45, 90, 180,
  360 s), since brushed drums getting busier read much like hiss; an
  abandoned standby (timed out after 20 s of rendered audio, or failed)
  counts as an attempt, so a machine with no slack cannot restart it forever. During a
  back-off, a sustained `drifted` takes the fresh-state splice, which
  re-learns the baseline. The fresh state also remains the fallback with no
  clean anchor, after a station change on a rising floor, or when priming
  cannot finish within 20 s because the machine has no slack.

With that policy, and the same session seed as the current guard:

| 8-minute take | Worst 30 s window | Typical | Splices |
|---|---:|---:|---:|
| rainy-piano, no drums, 10 cb, previous guard | -54.0 dBFS | about -63 | 1 fresh |
| same, re-prime, CFG 4.0 | -57.3 | about -65 | 6 |
| same, re-prime, CFG 5.5 | -56.6 | about -65 | 3 + 1 fresh |
| rainy-piano, drums, 12 cb, re-prime, CFG 4.0 | -46.5 | about -62 | 4 + 2 fresh |
| same, re-prime, CFG 5.5 | -56.2 | about -62 | 3 |

Stronger MusicCoCa guidance slows how quickly a bed regrows on the sparse
station, so it needs fewer splices - each one a short jump in the music. It
is not a universal lever, which is why it is per station:

| 8-minute take, final policy | CFG 4.0 (4.3 at the neutral dial) | CFG 5.0 (5.4) |
|---|---|---|
| rainy-piano, no drums, seed 888, 12 cb | 2 splices, worst -58.8 dBFS | 0 splices, worst -63.0 |
| rainy-piano, no drums, seed 777, 10 cb | 4 splices, worst -56.5 | 3 splices, worst -55.3 before the first |
| dusty-beats, drums, 12 cb | 2 splices, worst -57.8 | 4 + 1 fresh, worst -55.0 |

Pushing "dusty drums" harder makes the texture that prompt asks for dustier.
The global default stays 4.0 and Rainy Piano carries `guidance=1.25` in
`backend/styles.py`. `MRT_TAKE_REPRIME=0` restores the fresh-state-only guard,
`MRT_ANCHOR_SECONDS` shortens the memory, and `/health` reports
`takeReprimes` per session.

## Long takes, third pass: remove the bed the listener hears

A listener still heard static that grew. Two things let it through. The guard
is relative: it acts on a rise over the take's own opening and returns a take
only to that level, while a lo-fi take's opening already carries an audible
bed (every station and sound-editor vibe says "lo-fi", and the editor's
effects add "vinyl crackle", "warm tape", "soft rain"). And a station or
custom-mix change re-learned that reference from a state already drifting, so
the guard stood down exactly when the bed grew fastest: recording the audio
actually delivered (`MRT_RECORD_DIR`), a switch to a custom mix crept from
-84 to -70 dBFS in three minutes with no repair.

**The filter.** `backend/hiss_filter.py` processes every stream after the
guard (which keeps watching the raw model output). Above 2-3.5 kHz:

- each bin's floor is the 20th percentile of its power over three seconds,
  and a decision-directed Wiener gain (floor -20 dB) removes it; notes, hats
  and brushes sit far above that percentile and pass;
- bins whose three-second median stands 18 dB over their neighbourhood
  above 4 kHz - the model's fixed-pitch whistles (5.25, 8.4, 3.3 kHz
  measured) - use the median as their floor and may be cut 35 dB;
- above 13 kHz the median sets the floor, and above 12 kHz each frame's
  narrow peaks are clipped to 8 dB over the local envelope, for the pulsing
  comb of 15-18 kHz whistles that rings in with each hat.

| Take (8 min, raw model output) | Quiet 5-13 kHz | Loud 5-13 kHz | Quiet 13-20 kHz | Loud 13-20 kHz |
|---|---|---|---|---|
| dusty-beats | -60.0 -> -76.3 | -41.9 -> -42.5 | -64.1 -> -83.1 | -54.7 -> -57.0 |
| dusty-beats, second seed | -62.7 -> -81.9 | -33.4 -> -33.6 | -71.6 -> -91.1 | -40.2 -> -40.3 |
| sunlit-groove | -67.1 -> -81.3 | -47.1 -> -47.5 | -80.1 -> -97.8 | -61.1 -> -61.7 |
| rainy-piano runaway | -65.2 -> -82.1 | -30.0 -> -30.1 | -70.4 -> -89.9 | -39.4 -> -40.6 |

It costs about 6 ms of NumPy per 400 ms chunk on the M3 Pro and one 21 ms
hop of latency. When a prompt asks for rain, vinyl, tape, hiss, static or
noise, it stands aside. `MRT_HISS_FILTER=0` disables it.

**The guard across style changes.** `TakeFloorMonitor.relearn_baseline`
keeps the old reference judging while the new style's is learned, and the
take keeps the lower of the two. A busier station can therefore cost one
fresh-state splice; a bed carried across cannot become the new normal. On
the same switch to a custom mix, the delivered floor then stayed between
-76 and -91 dBFS for six minutes, with two re-primes and one fresh splice.

**Stall on a new prompt.** The first custom prompt after warm-up rebuilds
MusicCoCa's text encoder, which holds the GIL for 580 ms and froze the model
thread even from another thread (the listener heard gaps at 4x real time).
New text prompts are now embedded in a short-lived child process
(`backend/style_embedder.py`, 6 ms worst stall on the model thread, identical
embeddings) while the current style keeps playing; the child exits after a
minute idle, returning its memory.

## Resource budget on an 8GB M1 Air

The M1 Air was not available; these were measured on the M3 Pro (18 GB) with
other work on the host, so absolute numbers carry about +/-20% noise.

- **Chunk length.** The batched codec's cost per frame and its transient
  memory both depend on chunk length:

  | Frames per call | Codec ms/frame (compiled) | Transient peak |
  |---:|---:|---:|
  | 1 | 9.5 | +211 MB |
  | 5 | 3.3 | +355 MB |
  | 10 | 2.7 | +534 MB |
  | 20 | 2.2 | +870 MB |

  Twenty frames would save about 0.5 ms per frame for 336 MB more churn every
  chunk on an 8 GB machine, so ten stays.
- **Four-bit weights are not a speed lever on MLX 0.32.2**: 31 ms per frame
  against 11 at 8-bit, even with the codec left in float32. They only save
  memory.
- **Garbage collection.** Loading leaves about 268,000 long-lived Python
  objects; a full collection took 37 ms on the M3 Pro, on the model thread,
  at arbitrary moments. `gc.freeze()` after warm-up leaves the collector only
  per-frame objects.
- **The frontend is a static export.** One file server
  (`frontend/static_server.py`) at about 23 MB replaces
  `next start` and its workers (about 355 MB RSS, 199 MB footprint).
- **The page yields to the model.** The two canvases cost about 4 ms of main
  thread per frame at 60fps on the M3 Pro, plus Chrome's rasterization and a
  full-screen backdrop blur recomputed under every animated frame - all on
  the same GPU and memory bus as MLX. The cat now paints at 30fps. When the
  backend reports under 1.45x real time, a reduced codec depth, a reservoir
  held low for three seconds, or a gap, the page enters low power
  (visualizer 30fps, cat 20fps, no trail, no backdrop blur or decorative CSS
  motion) and leaves only after 90 s at 1.7x with full depth and two minutes
  in low power.
- **Opt-in residency.** `MRT_WIRED_LIMIT_MB` (macOS 15+) keeps the model's
  MLX memory wired so swap pressure from the browser cannot page it out
  mid-stream; about 1100 MB covers a rendering chunk.

## Why not use the official native runner yet?

Google's production-style macOS examples use the C++ `RealtimeRunner`, an
exported `.mlxfn` graph, a lock-free stereo ring, a dedicated inference thread,
and GPU keepalive. That is the right eventual host architecture.

On the current installation, however, the published graph did not import with
the tested older MLX build, while MLX 0.32.2 imports and runs it but decodes
noise-like output. The graph path measured about 1.12x real time, so enabling it
would improve speed by sacrificing valid audio. Building the official benchmark
also requires the full Xcode Metal toolchain, which is not installed on this
machine. lofAI therefore keeps the verified eager checkpoint path and borrows
the safe runtime ideas: one inference thread, bounded rings, prewarming, and GPU
keepalive.

Revisit native integration when an upstream graph and supported MLX release
round-trip cleanly on this machine. Validate decoded signal and a listening
sample before treating a faster benchmark as usable.

## Operational rules

- `renderRealtimeFactor` in `GET /health` is the primary capacity signal. A
  sustained value below 1.0 is a compute problem, not a buffering problem.
- Keep `MRT_MAX_SESSIONS=1` on an M1 Air. One shared model can hold many states,
  but active listeners divide the same serial inference budget.
- Leave `MRT_CODEBOOKS` unset for live use. Pin 12 only for offline comparison.
- Use `mrt2_base` only offline on this machine; Google specifies the small model
  for Air-class real-time generation.
- Musical changes need blind listening tests. Signal metrics are useful only to
  reject silence, clipping, corruption, or obviously noise-like output.
