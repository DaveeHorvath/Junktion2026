// Bone transform hierarchy for the hand skeleton.
//
// Mutable by design: the solver poses bones by assigning either their world or
// their local rotation, and each node keeps both representations in sync
// (setting one derives the other from the parent). Transforms are stored as
// position/rotation/scale directly — no matrices — since the solver only ever
// reads pos/rot/scale.
//
// Storage is allocation-free on the hot path: each node owns four fixed
// arrays, and the setters and FK kernels write into them component-wise. The
// solver walks the tree ~10 times per solve per hand at display rate, so
// fresh arrays per node per pass were the app's dominant allocation churn
// (measured 20-40 MB/s; see dev/PerfMonitor.tsx for how that was diagnosed).
// The getters expose the fixed arrays as readonly Vec3/Quat views — read
// them, don't retain them across writes. The scalar kernels replicate the
// math.ts formulas expression-for-expression, so optimizing the allocations
// away did not move a single result.

import {
  qInverse,
  qMul,
  qNormalize,
  vAdd,
  vScale,
  vSub,
  vTransform,
  type Quat,
  type Vec3,
} from "./math.ts";

type Mut3 = [number, number, number];
type Mut4 = [number, number, number, number];

function copy3(out: Mut3, v: Vec3): void {
  out[0] = v[0];
  out[1] = v[1];
  out[2] = v[2];
}

function copy4(out: Mut4, q: Quat): void {
  out[0] = q[0];
  out[1] = q[1];
  out[2] = q[2];
  out[3] = q[3];
}

/**
 * out ← normalize(a ∘ b), the world-rotation FK step. Same expressions as
 * qNormalize(qMul(a, b)); computed into scalars first, so `out` may alias
 * either input.
 */
function qMulNormalizeInto(out: Mut4, a: Quat, b: Quat): void {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  out[3] = w / len;
}

/**
 * out ← base + rot·(v·scale), the world-position FK step. Same expressions as
 * vAdd(base, vTransform(vScale(v, scale), rot)); `out` may alias any input.
 */
function scaleRotateAddInto(out: Mut3, v: Vec3, scale: number, rot: Quat, base: Vec3): void {
  const vx = v[0] * scale;
  const vy = v[1] * scale;
  const vz = v[2] * scale;
  const [qx, qy, qz, qw] = rot;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  const rx = vx + qw * tx + (qy * tz - qz * ty);
  const ry = vy + qw * ty + (qz * tx - qx * tz);
  const rz = vz + qw * tz + (qx * ty - qy * tx);
  out[0] = base[0] + rx;
  out[1] = base[1] + ry;
  out[2] = base[2] + rz;
}

/**
 * out ← (v − origin) rotated by rot⁻¹, then divided by scale (skipped when
 * scale is 0, matching the setter's original guard) — the world→local
 * position step. Same expressions as
 * vScale(vTransform(vSub(v, origin), qInverse(rot)), 1 / scale).
 */
function invRotateScaleInto(out: Mut3, v: Vec3, origin: Vec3, rot: Quat, scale: number): void {
  const dx = v[0] - origin[0];
  const dy = v[1] - origin[1];
  const dz = v[2] - origin[2];
  const lenSq = rot[0] * rot[0] + rot[1] * rot[1] + rot[2] * rot[2] + rot[3] * rot[3];
  const inv = 1 / lenSq;
  const qx = -rot[0] * inv;
  const qy = -rot[1] * inv;
  const qz = -rot[2] * inv;
  const qw = rot[3] * inv;
  const tx = 2 * (qy * dz - qz * dy);
  const ty = 2 * (qz * dx - qx * dz);
  const tz = 2 * (qx * dy - qy * dx);
  const s = scale !== 0 ? 1 / scale : 1;
  out[0] = (dx + qw * tx + (qy * tz - qz * ty)) * s;
  out[1] = (dy + qw * ty + (qz * tx - qx * tz)) * s;
  out[2] = (dz + qw * tz + (qx * ty - qy * tx)) * s;
}

export class TransformNode {
  private readonly _rotation: Mut4 = [0, 0, 0, 1];
  private readonly _position: Mut3 = [0, 0, 0];
  private readonly _localRotation: Mut4 = [0, 0, 0, 1];
  private readonly _localPosition: Mut3 = [0, 0, 0];

  localScale = 1;
  lossyScale = 1;

  parent: TransformNode | null = null;
  readonly children: TransformNode[] = [];

  constructor(public readonly name: string = "") {}

  // ── World/local duality (each setter derives the other representation) ────

  get rotation(): Quat {
    return this._rotation;
  }

  set rotation(value: Quat) {
    const p = this.parent;
    if (p) {
      // local = normalize(parent.rotation⁻¹ ∘ value); inverse per qInverse.
      const lenSq =
        p._rotation[0] * p._rotation[0] +
        p._rotation[1] * p._rotation[1] +
        p._rotation[2] * p._rotation[2] +
        p._rotation[3] * p._rotation[3];
      const inv = 1 / lenSq;
      const iq: Quat = [
        -p._rotation[0] * inv,
        -p._rotation[1] * inv,
        -p._rotation[2] * inv,
        p._rotation[3] * inv,
      ];
      qMulNormalizeInto(this._localRotation, iq, value);
    } else {
      copy4(this._localRotation, value);
    }
    copy4(this._rotation, value);
  }

  get position(): Vec3 {
    return this._position;
  }

  set position(value: Vec3) {
    if (this.parent) {
      invRotateScaleInto(
        this._localPosition,
        value,
        this.parent._position,
        this.parent._rotation,
        this.parent.lossyScale,
      );
    } else {
      copy3(this._localPosition, value);
    }
    copy3(this._position, value);
  }

  get localRotation(): Quat {
    return this._localRotation;
  }

  set localRotation(value: Quat) {
    if (this.parent) {
      qMulNormalizeInto(this._rotation, this.parent._rotation, value);
    } else {
      copy4(this._rotation, value);
    }
    copy4(this._localRotation, value);
  }

  get localPosition(): Vec3 {
    return this._localPosition;
  }

  set localPosition(value: Vec3) {
    if (this.parent) {
      scaleRotateAddInto(
        this._position,
        value,
        this.parent.lossyScale,
        this.parent._rotation,
        this.parent._position,
      );
    } else {
      copy3(this._position, value);
    }
    copy3(this._localPosition, value);
  }

  /** World-space direction for a local direction (rotation + lossy scale). */
  transformVector(v: Vec3): Vec3 {
    return vTransform(vScale(v, this.lossyScale), this._rotation);
  }

  // ── Recursive child propagation ────────────────────────────────────────────

  /** Recompute world transforms for all descendants from this node's state. */
  updateChildTransformsRecursive(): void {
    for (const child of this.children) {
      qMulNormalizeInto(child._rotation, this._rotation, child._localRotation);
      scaleRotateAddInto(
        child._position,
        child._localPosition,
        this.lossyScale,
        this._rotation,
        this._position,
      );
      child.lossyScale = this.lossyScale * child.localScale;
      child.updateChildTransformsRecursive();
    }
  }

  private root(): TransformNode {
    let node: TransformNode = this;
    while (node.parent) node = node.parent;
    return node;
  }

  /**
   * Rotate then translate the hierarchy's root so this node ends up at
   * `targetPosition` with `targetRotation`.
   */
  alignRootTo(targetPosition: Vec3, targetRotation: Quat): void {
    const root = this.root();

    const rotDelta = qMul(targetRotation, qInverse(this._rotation));
    copy4(root._rotation, qNormalize(qMul(rotDelta, root._rotation)));
    copy4(root._localRotation, root._rotation); // root has no parent
    root.updateChildTransformsRecursive();

    const posDelta = vSub(targetPosition, this._position);
    copy3(root._position, vAdd(root._position, posDelta));
    copy3(root._localPosition, root._position);
    root.updateChildTransformsRecursive();
  }

  /**
   * Apply a world-space alignment delta (rotation then translation) to this
   * node. Order matters: the new position is computed from the OLD world
   * position, before the new rotation is assigned.
   */
  applyAlignment(rotDelta: Quat, posDelta: Vec3): void {
    const newPos = vAdd(vTransform(this._position, rotDelta), posDelta);
    this.rotation = qNormalize(qMul(rotDelta, this._rotation));
    this.position = newPos;
  }

  // ── Batch FK propagation ───────────────────────────────────────────────────

  /**
   * Propagate world transforms from roots down. Assumes parents precede
   * children in the array (glTF joint order guarantees this).
   */
  static propagateWorldTransforms(nodes: readonly TransformNode[]): void {
    for (const t of nodes) {
      const p = t.parent;
      if (!p) {
        copy4(t._rotation, t._localRotation);
        copy3(t._position, t._localPosition);
        t.lossyScale = t.localScale;
      } else {
        qMulNormalizeInto(t._rotation, p._rotation, t._localRotation);
        scaleRotateAddInto(t._position, t._localPosition, p.lossyScale, p._rotation, p._position);
        t.lossyScale = p.lossyScale * t.localScale;
      }
    }
  }
}
