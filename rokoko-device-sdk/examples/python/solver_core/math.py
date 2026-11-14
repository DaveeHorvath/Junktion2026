# Vector and quaternion math for the hand solver.

from __future__ import annotations

import math
import sys

Vec3 = tuple[float, float, float]
Quat = tuple[float, float, float, float]

VEC3_ZERO: Vec3 = (0.0, 0.0, 0.0)
VEC3_UNIT_X: Vec3 = (1.0, 0.0, 0.0)
VEC3_UNIT_Y: Vec3 = (0.0, 1.0, 0.0)
QUAT_IDENTITY: Quat = (0.0, 0.0, 0.0, 1.0)


# Squared-length threshold below which a vector is treated as zero-length
_EPSILON_NORMAL_SQRT = 1e-15


def v_add(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def v_sub(a: Vec3, b: Vec3) -> Vec3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def v_scale(a: Vec3, s: float) -> Vec3:
    return (a[0] * s, a[1] * s, a[2] * s)


def v_neg(a: Vec3) -> Vec3:
    return (-a[0], -a[1], -a[2])


def v_dot(a: Vec3, b: Vec3) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def v_cross(a: Vec3, b: Vec3) -> Vec3:
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def v_length_sq(a: Vec3) -> float:
    return v_dot(a, a)


def v_normalize(a: Vec3) -> Vec3:
    return v_scale(a, 1 / math.hypot(*a))


def v_normalize_safe(a: Vec3) -> Vec3 | None:
    """The normalized vector, or None when (near-)zero length."""
    length_sq = v_length_sq(a)
    if length_sq > _EPSILON_NORMAL_SQRT:
        return v_scale(a, 1 / math.sqrt(length_sq))
    return None


def v_transform(v: Vec3, q: Quat) -> Vec3:
    """Rotate `v` by `q`: q v q⁻¹."""
    qx, qy, qz, qw = q
    tx = 2 * (qy * v[2] - qz * v[1])
    ty = 2 * (qz * v[0] - qx * v[2])
    tz = 2 * (qx * v[1] - qy * v[0])
    return (
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    )


def q_mul(a: Quat, b: Quat) -> Quat:
    """Hamilton product a*b (apply b, then a)."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def q_inverse(q: Quat) -> Quat:
    length_sq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]
    inv = 1 / length_sq
    return (-q[0] * inv, -q[1] * inv, -q[2] * inv, q[3] * inv)


def q_normalize(q: Quat) -> Quat:
    length = math.hypot(*q)
    return (q[0] / length, q[1] / length, q[2] / length, q[3] / length)


def q_lerp(a: Quat, b: Quat, t: float) -> Quat:
    """Component-wise lerp taking the shorter arc (negate `b` when the dot
    is negative), then normalize. Not a true slerp — close enough for the
    small per-frame deltas the solver blends, and cheaper."""
    t1 = 1 - t
    dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
    s = t if dot >= 0 else -t
    return q_normalize(
        (
            t1 * a[0] + s * b[0],
            t1 * a[1] + s * b[1],
            t1 * a[2] + s * b[2],
            t1 * a[3] + s * b[3],
        )
    )


def euler(x: float, y: float, z: float) -> Quat:
    half_x = math.radians(x) * 0.5
    half_y = math.radians(y) * 0.5
    half_z = math.radians(z) * 0.5
    cx, sx = math.cos(half_x), math.sin(half_x)
    cy, sy = math.cos(half_y), math.sin(half_y)
    cz, sz = math.cos(half_z), math.sin(half_z)
    return (
        sx * cy * cz + cx * sy * sz,
        cx * sy * cz - sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
        cx * cy * cz + sx * sy * sz,
    )


def euler_vec(v: Vec3) -> Quat:
    return euler(v[0], v[1], v[2])


def _quat_from_basis(right: Vec3, up: Vec3, forward: Vec3) -> Quat:
    """Matrix-to-quaternion conversion (Shepperd's method) """
    m00, m01, m02 = right
    m10, m11, m12 = up
    m20, m21, m22 = forward

    trace = m00 + m11 + m22
    w_is_largest = trace > 0
    x_is_largest = m00 >= m11 and m00 >= m22
    y_is_largest = m11 > m22

    if w_is_largest:
        root = math.sqrt(trace + 1)
        w = root * 0.5
        scale = 0.5 / root
        return ((m12 - m21) * scale, (m20 - m02) * scale, (m01 - m10) * scale, w)
    if x_is_largest:
        root = math.sqrt(1 + m00 - m11 - m22)
        scale = 0.5 / root
        return (
            0.5 * root,
            (m01 + m10) * scale,
            (m02 + m20) * scale,
            (m12 - m21) * scale,
        )
    if y_is_largest:
        root = math.sqrt(1 + m11 - m00 - m22)
        scale = 0.5 / root
        return (
            (m10 + m01) * scale,
            0.5 * root,
            (m21 + m12) * scale,
            (m20 - m02) * scale,
        )
    root = math.sqrt(1 + m22 - m00 - m11)
    scale = 0.5 / root
    return ((m20 + m02) * scale, (m21 + m12) * scale, 0.5 * root, (m01 - m10) * scale)


def look_rotation(forward: Vec3, up: Vec3) -> Quat:
    """Rotation whose local +Z points along `forward` and local +Y is `up`
    after orthonormalization. The basis is right = up × forward, so it is
    the only function here that bakes in a coordinate convention; the
    solver uses it self-consistently and corrects for the bone's local
    axes at the call site."""
    f = v_normalize(forward)
    right = v_normalize(v_cross(up, f))
    new_up = v_cross(f, right)
    return _quat_from_basis(right, new_up, f)


def angle_axis(degrees: float, axis: Vec3) -> Quat:
    """Rotation of `degrees` about `axis`; identity for a zero axis."""
    if v_length_sq(axis) == 0:
        return QUAT_IDENTITY
    a = v_normalize(axis)
    half = math.radians(degrees) * 0.5
    s = math.sin(half)
    return (a[0] * s, a[1] * s, a[2] * s, math.cos(half))


def angle(from_dir: Vec3, to_dir: Vec3) -> float:
    """Unsigned angle between two vectors, in degrees."""
    denominator = math.sqrt(v_length_sq(from_dir) * v_length_sq(to_dir))
    if denominator < _EPSILON_NORMAL_SQRT:
        return 0.0
    dot = min(max(v_dot(from_dir, to_dir) / denominator, -1.0), 1.0)
    return math.degrees(math.acos(dot))


def from_to_rotation(from_direction: Vec3, to_direction: Vec3) -> Quat:
    deg = angle(from_direction, to_direction)
    axis = v_cross(from_direction, to_direction)
    return angle_axis(deg, axis)


def q_project(q: Quat, axis: Vec3) -> Quat:
    stay_axis = v_transform(axis, q)
    down_rotate = from_to_rotation(stay_axis, axis)
    return q_normalize(q_mul(down_rotate, q))


def inverse_lerp(lo: float, hi: float, value: float) -> float:
    """Where `value` falls in [lo, hi], clamped to [0, 1]. Returns `lo`
    (not 0) when the range is degenerate."""
    if abs(hi - lo) < sys.float_info.epsilon:
        return lo
    t = (value - lo) / (hi - lo)
    return min(max(t, 0.0), 1.0)
