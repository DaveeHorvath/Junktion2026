// 3D math for the hand solver: quaternions and vectors, plus the conventions
// the rest of the solver relies on.
//
// Quaternions are [x, y, z, w] and rotate actively (q v q⁻¹), composed with
// the Hamilton product — qMul(a, b) applies b, then a. Most of this file is
// convention-agnostic: the operations are the same in any coordinate frame,
// right- or left-handed. Only two functions encode a convention, called out on
// their own doc comments:
//
//   - euler(x, y, z): builds a rotation in ZXY order (degrees).
//   - lookRotation(forward, up): builds a rotation whose local +Z points along
//     `forward`, with the basis right = up × forward.
//
// The solver runs end to end in these conventions on the gloves' right-handed
// sensor frame; nothing here flips an axis or changes handedness. The only
// hand-off to three.js is a single proper rotation at the render boundary
// (DEVICE_TO_THREE_ROTATION in scene/HandRig.tsx), which preserves handedness.
//
// Every function here is pinned to values captured from the reference
// implementation by the solver's regression tests. Those tests and their
// fixtures are not part of the SDK.

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export const VEC3_ZERO: Vec3 = [0, 0, 0];
export const VEC3_UNIT_X: Vec3 = [1, 0, 0];
export const VEC3_UNIT_Y: Vec3 = [0, 1, 0];
export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export const RAD2DEG = 180 / Math.PI;
export const DEG2RAD = Math.PI / 180;

/** Squared-length threshold below which a vector is treated as zero-length. */
const EPSILON_NORMAL_SQRT = 1e-15;

// ── Vectors ──────────────────────────────────────────────────────────────────

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function vNeg(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

export function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vCross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function vLengthSq(a: Vec3): number {
  return vDot(a, a);
}

export function vLength(a: Vec3): number {
  return Math.sqrt(vLengthSq(a));
}

export function vNormalize(a: Vec3): Vec3 {
  return vScale(a, 1 / vLength(a));
}

/** NormalizeSafe: the normalized vector, or null when (near-)zero length. */
export function vNormalizeSafe(a: Vec3): Vec3 | null {
  const lenSq = vLengthSq(a);
  if (lenSq > EPSILON_NORMAL_SQRT) return vScale(a, 1 / Math.sqrt(lenSq));
  return null;
}

/** Rotate `v` by `q`: q v q⁻¹. */
export function vTransform(v: Vec3, q: Quat): Vec3 {
  const [qx, qy, qz, qw] = q;
  // t = 2 (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

// ── Quaternions ──────────────────────────────────────────────────────────────

/** Hamilton product a*b (apply b, then a). */
export function qMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qInverse(q: Quat): Quat {
  const lenSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  const inv = 1 / lenSq;
  return [-q[0] * inv, -q[1] * inv, -q[2] * inv, q[3] * inv];
}

export function qNormalize(q: Quat): Quat {
  const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Component-wise lerp taking the shorter arc (negate `b` when the dot is
 * negative), then normalize. Not a true slerp — close enough for the small
 * per-frame deltas the solver blends, and cheaper.
 */
export function qLerp(a: Quat, b: Quat, t: number): Quat {
  const t1 = 1 - t;
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot >= 0 ? t : -t;
  return qNormalize([
    t1 * a[0] + s * b[0],
    t1 * a[1] + s * b[1],
    t1 * a[2] + s * b[2],
    t1 * a[3] + s * b[3],
  ]);
}

// ── Rotation constructors ────────────────────────────────────────────────────

/** Euler angles (degrees) to a quaternion, applied in ZXY order. */
export function euler(x: number, y: number, z: number): Quat {
  const halfX = x * DEG2RAD * 0.5;
  const halfY = y * DEG2RAD * 0.5;
  const halfZ = z * DEG2RAD * 0.5;
  const cx = Math.cos(halfX);
  const sx = Math.sin(halfX);
  const cy = Math.cos(halfY);
  const sy = Math.sin(halfY);
  const cz = Math.cos(halfZ);
  const sz = Math.sin(halfZ);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz - sx * sy * cz,
    cx * cy * cz + sx * sy * sz,
  ];
}

export function eulerVec(v: Vec3): Quat {
  return euler(v[0], v[1], v[2]);
}

/**
 * Quaternion to euler angles (degrees), ZXY order — the inverse of euler().
 * x is in [-90, 90], y and z in (-180, 180]. At the gimbal-lock poles
 * (x = ±90°) the y and z rotations act about the same axis, so the split is
 * ambiguous; the combined rotation is reported on y and z is set to 0.
 */
export function quatToEuler(q: Quat): Vec3 {
  const [qx, qy, qz, qw] = qNormalize(q);
  const sinX = 2 * (qx * qw - qy * qz);
  if (Math.abs(sinX) > 1 - 1e-7) {
    const sign = Math.sign(sinX);
    const m00 = 1 - 2 * (qy * qy + qz * qz);
    const m01 = 2 * (qx * qy - qz * qw);
    return [90 * sign, Math.atan2(sign * m01, m00) * RAD2DEG, 0];
  }
  return [
    Math.asin(sinX) * RAD2DEG,
    Math.atan2(2 * (qx * qz + qy * qw), 1 - 2 * (qx * qx + qy * qy)) * RAD2DEG,
    Math.atan2(2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz)) * RAD2DEG,
  ];
}

/**
 * Rotation whose local +Z points along `forward` and local +Y is `up` after
 * orthonormalization. The basis is right = up × forward, so it is the only
 * function here that bakes in a coordinate convention; the solver uses it
 * self-consistently and corrects for the bone's local axes at the call site.
 */
export function lookRotation(forward: Vec3, up: Vec3): Quat {
  const f = vNormalize(forward);
  const right = vNormalize(vCross(up, f));
  const newUp = vCross(f, right);
  // The rotation matrix, one basis vector per row.
  const [m00, m01, m02] = right;
  const [m10, m11, m12] = newUp;
  const [m20, m21, m22] = f;

  const trace = m00 + m11 + m22;
  if (trace > 0) {
    let num = Math.sqrt(trace + 1);
    const w = num * 0.5;
    num = 0.5 / num;
    return [(m12 - m21) * num, (m20 - m02) * num, (m01 - m10) * num, w];
  }
  if (m00 >= m11 && m00 >= m22) {
    const num7 = Math.sqrt(1 + m00 - m11 - m22);
    const num4 = 0.5 / num7;
    return [0.5 * num7, (m01 + m10) * num4, (m02 + m20) * num4, (m12 - m21) * num4];
  }
  if (m11 > m22) {
    const num6 = Math.sqrt(1 + m11 - m00 - m22);
    const num3 = 0.5 / num6;
    return [(m10 + m01) * num3, 0.5 * num6, (m21 + m12) * num3, (m20 - m02) * num3];
  }
  const num5 = Math.sqrt(1 + m22 - m00 - m11);
  const num2 = 0.5 / num5;
  return [(m20 + m02) * num2, (m21 + m12) * num2, 0.5 * num5, (m01 - m10) * num2];
}

/** Rotation of `degrees` about `axis`; identity for a zero axis. */
export function angleAxis(degrees: number, axis: Vec3): Quat {
  if (vLengthSq(axis) === 0) return QUAT_IDENTITY;
  const a = vNormalize(axis);
  const half = degrees * DEG2RAD * 0.5;
  const s = Math.sin(half);
  return [a[0] * s, a[1] * s, a[2] * s, Math.cos(half)];
}

/** Unsigned angle between two vectors, in degrees. */
export function angle(from: Vec3, to: Vec3): number {
  const denominator = Math.sqrt(vLengthSq(from) * vLengthSq(to));
  if (denominator < EPSILON_NORMAL_SQRT) return 0;
  const dot = Math.min(Math.max(vDot(from, to) / denominator, -1), 1);
  return Math.acos(dot) * RAD2DEG;
}

/** Shortest rotation taking `fromDirection` onto `toDirection`. */
export function fromToRotation(fromDirection: Vec3, toDirection: Vec3): Quat {
  const deg = angle(fromDirection, toDirection);
  const axis = vCross(fromDirection, toDirection);
  return angleAxis(deg, axis);
}

/**
 * Project: remove the component of rotation that moves `axis` — the result
 * is `q` with its swing relative to `axis` cancelled (twist-preserving).
 */
export function qProject(q: Quat, axis: Vec3): Quat {
  const stayAxis = vTransform(axis, q);
  const downRotate = fromToRotation(stayAxis, axis);
  return qNormalize(qMul(downRotate, q));
}

/**
 * Inverse lerp: where `value` falls in [min, max], clamped to [0, 1]. Returns
 * `min` (not 0) when the range is degenerate.
 */
export function inverseLerp(min: number, max: number, value: number): number {
  if (Math.abs(max - min) < Number.EPSILON) return min;
  const lerp = (value - min) / (max - min);
  return Math.min(Math.max(lerp, 0), 1);
}
