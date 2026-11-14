"""What the hand is doing, read from one frame.

Two steps. Featurisation strips the raw readings down to what the detector needs:
linear acceleration with gravity removed, every per-site IMU rotated into the hub
frame so one direction means one thing wherever it was measured. Kinematics then
reads the shape — which way the hand is held, how far round each finger has come,
where the fingertips are.

Hub frame, Smartgloves convention: an extended finger points -Y, palm-out is +Z,
and +Y is toward the wrist.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.spatial.transform import Rotation

from pinch_detection.frames import FINGERS, SITE_INDEX, SITES, HandFrame

# Under RGMP 2.0.0 a glove reports PROPER_ACCELERATION in g, whatever the protocol
# document says about m/s², and a resting hand reads about 1.0. Converting here is
# what puts every threshold below in m/s².
#
# Fixed rather than detected only because this example reads one protocol version
# and GloveLayout refuses every other. The SI correction is due with a later
# version, so anything that grows to read more than one has to pick this from the
# version rather than assume it.
G = 9.81

HUB_FORWARD = np.array([0.0, -1.0, 0.0])   # an extended finger
HUB_PALM_UP = np.array([0.0, 0.0, 1.0])    # out of the palm
GRAVITY_NED = np.array([0.0, 0.0, G])      # world gravity, LTP_NED (Z is down)

# How a finger's direction becomes one of the four states.
PROXIMAL_LIFT = 0.60
MEDIAL_LIFT = 0.50
BEND_LOW_RAD = np.deg2rad(50.0)
RAISED_BEND_RAD = np.deg2rad(55.0)

# The thumb is bent differently from the fingers and gets its own rule.
THUMB_RAISED_MEDIAL_Z = 0.50
THUMB_CURL_PROXIMAL_Z = 0.70
THUMB_CURL_BEND_RAD = np.deg2rad(60.0)

# Fingertip estimation. The sensor sits mid-bone on the back of the finger, so a
# tip is projected forward along the bone and then stepped palmward onto the
# fleshy surface where contact happens. It ignores the last joint, so it
# overshoots on a fully curled finger — which is why contact is judged from the
# collision and this is used only for direction.
TIP_FORWARD_THUMB_M = 0.045
TIP_FORWARD_FINGER_M = 0.035
TIP_PALMWARD_M = 0.010

# Reach at or below which a finger counts as not flexed at all.
#
# There is deliberately no upper bound, and adding one is a mistake worth naming:
# "curled past the thumb cannot be touching it" is false on hardware in both
# directions. A thumb-to-ring contact has the ring curled a long way; the pinky
# meets the thumb while barely flexed, because it cannot reach once curled.
REACH_EXTENDED = 0.20

# How far the leader must lead before the angles are taken to have separated two
# fingers. Sized from frame-to-frame noise (reach is stable to about ±0.01), not
# from how far apart two fingers sit: at 0.10 it exceeds the real separation, no
# finger can out-lead the incumbent, and whichever was named first keeps the title
# for ever.
REACH_MARGIN = 0.03

# Gravity is ~9.81 m/s²; requiring about two thirds along one axis to call that
# axis dominant keeps the orientation from flipping during ordinary hand motion.
GRAVITY_DOMINANCE = 6.5

EXTENDED, HOOKED, RAISED, CURLED = "extended", "hooked", "raised", "curled"


@dataclass(frozen=True)
class Features:
    """One frame's readings, with gravity removed and every site in the hub frame."""

    hand: str
    t_us: int
    accel: np.ndarray        # (7, 3) linear acceleration, m/s², SITES order
    gyro: np.ndarray         # (7, 3) angular velocity, rad/s, SITES order
    gravity_hub: np.ndarray  # (3,) gravity as the hub sees it


@dataclass(frozen=True)
class Kinematics:
    """One frame's shape."""

    hand: str
    t_us: int
    orientation: str                # one of ORIENTATIONS, or "mixed"
    finger_state: dict[str, str]
    tips: np.ndarray                # (5, 3) estimated fingertips, FINGERS order
    reach: np.ndarray               # (5,) how far round each finger has come
    most_reaching: str | None       # None when the hand is open


def featurize(frame: HandFrame) -> Features:
    """Gravity out, every site into the hub frame.

    Proper acceleration is specific force: at rest a sensor measures the reaction
    holding it up, which points *opposite* gravity. So linear acceleration is
    proper + g, not proper - g. Subtract instead and a resting hand carries about
    2g of residual pointing the wrong way, and the 'acceleration' tracks the
    gravity vector rotating through the hand rather than any real movement.
    """
    world = frame.hub_world
    gravity_hub = world.inv().apply(GRAVITY_NED) if world is not None else np.zeros(3)

    # Each finger IMU reports in its own frame, which rotates as the finger curls;
    # the arm sensor's frame is the hand's. Rotating every site into the hub's
    # makes one direction mean one thing wherever it was measured.
    to_hub = [Rotation.identity()] * len(SITES)
    for i, finger in enumerate(FINGERS):
        to_hub[SITE_INDEX[finger]] = frame.finger_rot[i]
    to_hub[SITE_INDEX["arm"]] = frame.hand_rotation

    accel = np.empty_like(frame.site_accel)
    gyro = np.empty_like(frame.site_gyro)
    for i in range(len(SITES)):
        accel[i] = to_hub[i].apply(frame.site_accel[i]) * G + gravity_hub
        gyro[i] = to_hub[i].apply(frame.site_gyro[i])

    return Features(
        hand=frame.hand,
        t_us=frame.t_us,
        accel=accel,
        gyro=gyro,
        gravity_hub=gravity_hub,
    )


def kinematics(frame: HandFrame, features: Features, previous: Kinematics | None) -> Kinematics:
    """The hand's shape: orientation, finger states, fingertips, reach."""
    # proximal: hub origin toward the sensor. medial: the bone's own direction.
    pos = frame.finger_pos
    lengths = np.linalg.norm(pos, axis=1, keepdims=True)
    proximal = np.where(lengths < 1e-6, HUB_FORWARD, pos / np.maximum(lengths, 1e-12))
    # Unit length already: HUB_FORWARD is, and a rotation preserves length.
    medial = frame.finger_rot.apply(HUB_FORWARD)

    bend = np.arccos(np.clip(np.einsum("ij,ij->i", medial, proximal), -1.0, 1.0))

    states: dict[str, str] = {}
    for i, finger in enumerate(FINGERS):
        states[finger] = (
            _thumb_state(proximal[i, 2], medial[i, 2], bend[i])
            if finger == "thumb"
            else _finger_state(proximal[i, 2], medial[i, 2], bend[i])
        )

    # Tip: forward along the bone, then palmward onto the contact surface.
    forward = np.array([TIP_FORWARD_THUMB_M] + [TIP_FORWARD_FINGER_M] * 4)[:, None]
    palm_dir = frame.finger_rot.apply(HUB_PALM_UP)
    tips = pos + medial * forward + palm_dir * TIP_PALMWARD_M

    # Reach is measured against the wrist direction (+Y), not palmward. Palmward
    # is the obvious choice and the wrong one: a curling finger swings -Y through
    # -Z to +Y, so its palmward component peaks at a right angle and falls back —
    # an extended finger and a fully curled one read the same. The wrist component
    # rises across the whole travel, so there is one reading per posture.
    reach = (1.0 + medial[:, 1]) / 2.0

    return Kinematics(
        hand=frame.hand,
        t_us=frame.t_us,
        orientation=_orientation(features.gravity_hub, frame.hand),
        finger_state=states,
        tips=tips,
        reach=reach,
        most_reaching=_most_reaching(
            reach, proximal[:, 1], previous.most_reaching if previous else None
        ),
    )


def _finger_state(proximal_z: float, medial_z: float, bend: float) -> str:
    if proximal_z >= PROXIMAL_LIFT:
        if medial_z >= MEDIAL_LIFT and bend <= RAISED_BEND_RAD:
            return RAISED
        return CURLED
    return EXTENDED if bend <= BEND_LOW_RAD else HOOKED


def _thumb_state(proximal_z: float, medial_z: float, bend: float) -> str:
    if medial_z >= THUMB_RAISED_MEDIAL_Z:
        return RAISED
    if proximal_z >= THUMB_CURL_PROXIMAL_Z and bend >= THUMB_CURL_BEND_RAD:
        return CURLED
    return EXTENDED


def _orientation(gravity_hub: np.ndarray, hand: str) -> str:
    """Which way the hand is held, from where gravity falls in the hub frame."""
    x, y, z = gravity_hub
    ax, ay, az = abs(x), abs(y), abs(z)

    if az >= GRAVITY_DOMINANCE and az >= ax and az >= ay:
        return "palm_down" if z > 0 else "palm_up"
    if ay >= GRAVITY_DOMINANCE and ay >= ax and ay >= az:
        return "fingers_up" if y > 0 else "fingers_down"
    if ax >= GRAVITY_DOMINANCE and ax >= ay and ax >= az:
        # +X is toward the pinky on the right hand and the thumb on the left, so
        # gravity along the pinky side means that side is resting down — a
        # handshake, which is edge_down.
        pinky_side = 1 if hand == "right" else -1
        return "edge_down" if x * pinky_side > 0 else "edge_up"
    return "mixed"


def _most_reaching(reach: np.ndarray, wristward: np.ndarray, previous: str | None) -> str | None:
    """Which finger has come furthest round, or None when the hand is open.

    Ambiguity is settled rather than reported: answering None for a near-tie is
    defensible but blanks the state exactly when a pose needs it.
    """
    candidates = [i for i in range(1, 5) if reach[i] > REACH_EXTENDED]  # thumb excluded
    if not candidates:
        return None

    best = max(reach[i] for i in candidates)
    tied = [i for i in candidates if best - reach[i] < REACH_MARGIN]
    if len(tied) == 1:
        return FINGERS[tied[0]]

    # A finger already named keeps the title while it is still in contention, so a
    # hand held still on a boundary does not change its answer at all.
    if previous is not None:
        for i in tied:
            if FINGERS[i] == previous:
                return previous

    # Otherwise the knuckle decides. Reach reads the medial bone's own angle;
    # this reads how far round the sensor has been carried, so where one cannot
    # separate two fingers the other usually can.
    return FINGERS[max(tied, key=lambda i: wristward[i])]
