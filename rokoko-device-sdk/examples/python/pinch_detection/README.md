# pinch_detection

**The four thumb pinches — thumb to index, middle, ring and pinky — recognised from
Rokoko Smartgloves, on both hands, from the raw RGMP v2 stream.**

```
gloves ─► Rokoko driver ──RGMP v2/TCP──► rgmp_pinch_detector.py ─► one line per event
                          :12276         (this package)             on stdout
```

Run it from `python/`:

```sh
uv run rgmp_pinch_detector.py      # fetches NumPy and SciPy into a throwaway env
python3 rgmp_pinch_detector.py     # or uses the ones you already have
```

```
Pinch  left  thumb_index   fired     #2     ...I|....
Pinch  left  thumb_index   released  #2     ....|....
```

That is the whole output. What a consumer does with a pinch is the consumer's
business, so the example prints and stops there.

## What you need

- **The Rokoko SDK driver**, started with `--auto-stream-usb` for USB or serial
  gloves — without it the driver accepts the connection and publishes nothing at
  all. No formatter flag is needed: RGMP v2 is what it publishes by default.
- **Rokoko Smartgloves, left and right.** Both gloves are read at the same time
  and matched against every shape, and each event names the hand that made it.
  Other devices on the same driver — a Smartsuit, a Coil Pro — are named on stderr
  and ignored.
- **NumPy and SciPy.** Unlike its neighbours this example is not standard-library
  only: the shape of a hand is linear algebra, and SciPy's `Rotation` does every
  quaternion in it. The entry script declares both as [PEP 723][pep723] inline
  metadata, so `uv run` fetches them into a throwaway environment and nothing is
  installed or left behind. Without `uv`:

  ```sh
  pip install numpy scipy
  ```

  [pep723]: https://peps.python.org/pep-0723/

- **Nothing else.** The package imports the sibling `rgmp_core` for the client,
  framing and payload offsets, and `solver_core.smartglove` for which sensor a
  stream belongs to — so it holds no private copy of the wire format or of the
  glove's own layout, and neither can fall out of step. Python puts the entry script's own directory on the import path, so the
  command above runs from the repository root as readily as from `python/`.

`--host` and `--port` move the connection; it defaults to `127.0.0.1:12276`.

## What it prints

A `fired` line when the two fingers meet, a `released` when they part, and one
count shared by the pair:

```
Pinch  left  thumb_index   fired     #2     ...I|....
Pinch  right thumb_ring    fired     #1     ...I|..R.
Pinch  left  thumb_index   released  #2     ....|..R.
```

**Every `fired` is closed by exactly one `released`**, so they can be paired
directly. That is less obvious than it looks, and `pairing.py` is the twenty lines
that make it true. The collision says a pinch happened; the hand's shape ending is
the only thing that says when it stopped — and the shape also ends every time
fingers approach without meeting. Driving the release off the shape alone sends
releases for pinches that never fired, measured against gloves at 16% of them.

### The lanes

The eight columns on the right are every pinch on both hands, held or not, so a held
pinch draws a column down the terminal as the lines stack up. A dot is idle and a
letter is that pinch being held. The left hand runs outward-in and the right
inward-out, mirroring a pair of hands held palms-down with the thumbs meeting at the
divider — so the same pinch on both hands is symmetric, `...I|I...`.

Everything left of the lanes is fixed width so they stay in column; `--verbose`
appends the sensor clock after them for the same reason. **That clock is per glove
and not comparable between them**: each device counts from its own power-on, so use
it to line a pinch up against that glove's own motion data and nothing else.

### `released` is a gesture ending, not an instant

**It says the hand stopped looking like that pinch, not that the fingertips parted.**
Nothing in the stream reports separation: the collision detects fingers *meeting*,
and the only later signal is the shape itself ending. Part your fingertips while
holding the rest of the hand still and the pose still matches, so the release waits.

Measured over 128 deliberate pinches, `fired` to `released` ran a median of 300 ms —
a quarter of them under 150 ms, a sixth over half a second. Some of that is genuine
hold time rather than lag, but if you are driving something that wants a crisp
release, this is the thing to know about.

## Tuning

`--threshold-scale` moves all four collision thresholds together; above 1 is
stricter, below 1 looser. Reach for it first when pinches under- or over-fire, as
the shipped numbers were measured on one wearer's hands.

`--orientations` sets which hand attitudes a pinch is accepted in, default
`fingers_up,edge_down`, or `any`.

## How it works

| Module | Role |
| --- | --- |
| `source.py` | `rgmp_core.RgmpClient` → one decoded frame per hand, per callback |
| `frames.py` | RGMP streams → one frame per hand, in the hub frame |
| `kinematics.py` | gravity removed, IMUs rotated into the hub frame, and the hand's shape read from it |
| `poses.py` | the four pinches, and debouncing a shape into held-or-not |
| `contact.py` | the collision, its four gates, and arbitration between rivals |
| `pairing.py` | turning two signals into `fired`/`released` pairs |
| `engine.py` | one tick, in order |

A pinch needs **both halves**. The shape says the hand is arranged for a thumb-to-N
pinch and names which finger has come furthest round; the collision says the two
fingers actually met. Neither is sufficient: no amount of flexion says which finger
is touching the thumb — a thumb-to-ring contact has the ring curled a long way
while the pinky meets the thumb barely flexed at all — and a collision on its own
does not say which pair produced it.

Matching is **categorical, not template-matched**: a shape is a set of discrete
constraints rather than a recorded sample to correlate against, which is why every
threshold here is a number you can find and change.

A shape does not name a hand. Every constraint is already hand-relative —
orientation is categorised against the frame's own hand, so `fingers_up` means the
same on either — so both gloves are matched against every shape and the event
carries which one made it.

Hub frame, the Smartgloves convention everything above `frames.py` works in: an
extended finger points −Y, palm-out is +Z, and +Y is toward the wrist.

## Two things that will bite you

**Acceleration arrives in g, not m/s².** The protocol document says
`PROPER_ACCELERATION` is m/s²; the driver sends g, and a resting hand reads about
1.0. `kinematics.G` is the conversion, and every threshold below it is in m/s².

It is a constant rather than something read from the data only because this example
reads one protocol version. The correction to SI is due to arrive with a later one,
so anything that grows to read more than one version has to pick the units from the
version instead of assuming them.

**Only RGMP 2.x is read; anything else is refused.** A 3.0.0 data frame is
byte-identical to a 2.0.0 one — the header's third `u64` is a capture timestamp
under 2.0.0 and a frame counter under 3.0.0 — so nothing downstream of the
definition can tell them apart. Read the wrong one here and every timing window
would silently become a frame count while everything else decoded perfectly.
`frames.GloveLayout` checks `protocol_version` at the definition frame, which is
the only place the difference is visible, and raises `frames.Unreadable`.

That refusal is per device, not per session: the glove is announced loudly on
stderr and then ignored, so a second glove on the right version keeps working
and you are told what to change. If nothing else was readable the run ends with
a non-zero status rather than a quiet "0 events", because by then the refusal
may have scrolled well out of sight.
