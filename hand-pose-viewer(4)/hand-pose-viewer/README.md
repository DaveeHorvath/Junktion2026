# Hand Pose Viewer

A Three.js page showing a skinned, rigged 5-finger hand, driven by transforms you POST to the server.
No npm install needed: Node 16+ only.

```
node server.js          # PORT=3000 by default (PORT=8080 node server.js to change)
```

Open http://localhost:3000, then POST poses to http://localhost:3000/pose.
Every open viewer receives each update instantly and moves smoothly into the new pose
(adjust "Follow speed" in the panel; far right = instant).

## Transform format

Each transform is 7 floats:

```
[pos.x, pos.y, pos.z, q1, q2, q3, q4]
```

- Quaternions are **x, y, z, w** by default. Send `?order=wxyz` (or `"order":"wxyz"`) if yours are w-first.
- Units are meters. The rest hand is ~18 cm tall.
- Parts: `palm`, `thumb`, `index`, `middle`, `ring`, `pinky` (`little` is accepted for pinky).
- Send any subset; parts you leave out keep their last pose. Send `null` for a part to return it to rest.

### Coordinate conventions (rest pose, right hand)

- Palm faces **+Z**, fingers point **+Y**, thumb is on **+X**.
- `palm` is the root: its transform is in world space.
- Finger transforms are **relative to the palm** (local space) by default: position = finger root (knuckle), quaternion = finger root orientation.
  Rest knuckle positions: index `[0.026, 0.089, 0]`, middle `[0.0085, 0.093, 0]`, ring `[-0.0105, 0.089, 0]`, pinky `[-0.0285, 0.081, 0]`, thumb `[0.033, 0.022, 0.011]`.
- Curling a finger toward the palm is a **positive rotation about X**.
- If your finger transforms are in world space, add `?space=world` (or `"space":"world"`) and the server converts them into palm space.
- Switch to a left hand in the panel (or open `/?hand=left`); its rest layout is mirrored across X.

### How a single finger quaternion becomes a curl

Each finger has three joints. With `"mode":"distribute"` (default) the finger's rotation relative to rest is split evenly
across all three joints, so one quaternion gives a natural curl. Because a quaternion can't encode more than 180°, the
total curl tops out at 180° in this mode.
With `"mode":"root"` the quaternion is applied to the root joint only and the finger stays straight.

For full control, a finger can carry **11 or 15 floats**: the 7 above, plus a local quaternion (same order) for the
middle joint, plus one for the tip joint. When these are present the root quaternion is applied as-is.

## Calibrating a glove (raw sensor data)

If your transforms come from a glove or tracker whose axes don't match the viewer's, calibrate once:

1. Hold an **open, flat hand**: fingers straight and together, thumb relaxed alongside the index.
2. POST that frame to `/calibrate`, in the same format as `/pose` (raw values relative to the hub/wrist sensor).
   Add `"hand":"left"` for a left hand, `"order":"wxyz"` if your quaternions are w-first.

The server works out the hand's axes from the finger sensor positions
(fingertip direction = mean of the finger sensors, sideways = index minus pinky)
and stores each finger's orientation as its neutral. The response shows the axes it found, expressed in your hub's frame.

From then on every `/pose` you send is raw glove data:
- each finger's rotation since calibration is mapped into the viewer's axes and applied on top of the rest hand;
- positions are ignored (the viewer's own knuckles are used), so sending sensor positions is fine;
- `wrist`/`palm` passes through unchanged.

`GET /calibrate` shows the stored calibration, `DELETE /calibrate` removes it. Calibrating twice replaces the old one.
The panel shows "calibrated" while one is active. Its test buttons bypass the calibration (`"calibrated": false` in a body does the same).

Accuracy: the axes are only as level as your sensors. If the finger sensors sit higher above the hand than the hub,
the hand will appear tilted by a few degrees.

## Spelling with recorded signs

`signs.csv` (next to `server.js`) holds one row per sign: a label, then 42 numbers, i.e. 6 blocks of
`[pos.x, pos.y, pos.z, qx, qy, qz, qw]` relative to the glove hub, in the order
wrist, index, pinky, middle, ring, thumb (`SIGN_ORDER` in `server.js`).

The row labelled `0` must be a relaxed open hand. The server calibrates the whole recording from it, so the signs
show correctly regardless of any live calibration. `GET /signs` returns every sign converted to viewer rotations,
and the file is re-read on every request, so you can replace it while the server runs.
Set `SIGNS_FILE=/path/to/reverse.csv` to use another file.

In the viewer, type a word in **Spell with recorded signs** and press Play (or Enter). Each sign smoothly blends in over
the *Transition* time, then holds for the *Hold* time (default 0.5 s). Letters without a recorded sign (e.g. j, z)
are skipped and struck through, and a space shows the neutral `0` hand. While a word plays, live poses from the server
are ignored; they apply again with the next pose sent after it finishes.

## Endpoint

| Method | Path      | What it does                                         |
|--------|-----------|------------------------------------------------------|
| POST   | `/pose`   | Set transforms (formats below)                       |
| GET    | `/pose`   | Current state as JSON                                |
| DELETE | `/pose`   | Reset everything to rest                             |
| POST   | `/calibrate` | Store an open-hand glove frame as the neutral pose |
| GET / DELETE | `/calibrate` | Show / remove the calibration                |
| GET    | `/signs` | Recorded signs from `signs.csv`, converted for the viewer |
| GET    | `/events` | Server-Sent Events stream the viewer listens to      |

CORS is open, so you can POST from any origin. Errors return `400` with `{"ok":false,"error":"…"}`.

### Accepted bodies

Named object (recommended):
```json
{ "palm":  [0, 0, 0,  0, 0, 0, 1],
  "index": [0.026, 0.089, 0,  0.5, 0, 0, 0.866] }
```

Same thing with options:
```json
{ "space": "world", "order": "wxyz", "mode": "distribute", "reset": false,
  "pose": { "palm": [ … ], "thumb": [ … ] } }
```

Flat array of 7 × N floats (N ≤ 6) in the order palm, thumb, index, middle, ring, pinky:
```json
[0,0,0,0,0,0,1,   0.033,0.022,0.011,0,0,0,1,   …]
```

Array of arrays in the same order, or plain text numbers (comma/space separated) also work.

## Examples

curl:
```bash
curl -X POST http://localhost:3000/pose -H "Content-Type: application/json" \
  -d '{"index":[0.026,0.089,0,0.5,0,0,0.866]}'
```

Python (streaming at ~60 Hz):
```python
import math, time, requests
t0 = time.time()
while True:
    a = (math.sin(time.time() - t0) + 1) * 1.3          # 0 … 2.6 rad curl
    q = [math.sin(a / 2), 0, 0, math.cos(a / 2)]        # rotation about X, xyzw
    requests.post("http://localhost:3000/pose", json={
        "index":  [0.026, 0.089, 0, *q],
        "middle": [0.0085, 0.093, 0, *q],
    })
    time.sleep(1 / 60)
```

JavaScript:
```js
await fetch("http://localhost:3000/pose", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ palm: [0, 0.05, 0, 0, 0.383, 0, 0.924] }),
});
```

## Notes

- **Style:** switch between Natural and Cyberpunk in the panel (remembered per browser), or open `/?style=cyber`.

- Three.js loads from the jsDelivr CDN, so the viewer's browser needs internet access.
- Opening `index.html` directly from disk works too: it connects to `http://localhost:3000`, or set `?server=http://host:port`.
- The panel's test buttons (Open / Fist / Point / Peace / Stream demo) send their poses through `POST /pose`, so they double as a working client example.
