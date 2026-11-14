# Bone transform hierarchy for the hand skeleton.

from __future__ import annotations

from solver_core.math import (
    Quat,
    QUAT_IDENTITY,
    Vec3,
    VEC3_ZERO,
    q_inverse,
    q_mul,
    q_normalize,
    v_add,
    v_sub,
    v_transform,
)


class TransformTree:
    """One bone. `rotation`/`position` are world-space; `local_rotation`/
    `local_position` are relative to `parent`. Assigning either pair
    recomputes the other from the current parent state."""

    def __init__(self, name: str = "") -> None:
        self.name = name
        self.parent: TransformTree | None = None
        self.children: list[TransformTree] = []
        self._rotation: Quat = QUAT_IDENTITY
        self._position: Vec3 = VEC3_ZERO
        self._local_rotation: Quat = QUAT_IDENTITY
        self._local_position: Vec3 = VEC3_ZERO

    @property
    def rotation(self) -> Quat:
        return self._rotation

    @rotation.setter
    def rotation(self, value: Quat) -> None:
        if self.parent is not None:
            self._local_rotation = q_normalize(
                q_mul(q_inverse(self.parent._rotation), value)
            )
        else:
            self._local_rotation = value
        self._rotation = value

    @property
    def position(self) -> Vec3:
        return self._position

    @position.setter
    def position(self, value: Vec3) -> None:
        if self.parent is not None:
            self._local_position = v_transform(
                v_sub(value, self.parent._position), q_inverse(self.parent._rotation)
            )
        else:
            self._local_position = value
        self._position = value

    @property
    def local_rotation(self) -> Quat:
        return self._local_rotation

    @local_rotation.setter
    def local_rotation(self, value: Quat) -> None:
        if self.parent is not None:
            self._rotation = q_normalize(q_mul(self.parent._rotation, value))
        else:
            self._rotation = value
        self._local_rotation = value

    @property
    def local_position(self) -> Vec3:
        return self._local_position

    @local_position.setter
    def local_position(self, value: Vec3) -> None:
        if self.parent is not None:
            self._position = v_add(
                self.parent._position, v_transform(value, self.parent._rotation)
            )
        else:
            self._position = value
        self._local_position = value

    def transform_vector(self, v: Vec3) -> Vec3:
        """World-space direction for a local direction (rotation only, no scale)."""
        return v_transform(v, self._rotation)

    def update_child_transforms_recursive(self) -> None:
        """Recompute world transforms for all descendants from this node's
        current state. Writes world fields directly (not via the public
        setters above) since local is already correct here — only world
        needs to catch up with wherever this node's world just moved to."""
        for child in self.children:
            child._rotation = q_normalize(q_mul(self._rotation, child._local_rotation))
            child._position = v_add(
                self._position, v_transform(child._local_position, self._rotation)
            )
            child.update_child_transforms_recursive()

    def _root(self) -> TransformTree:
        """Find the absolute parent (topmost ancestor) of this node."""
        node: TransformTree = self
        while node.parent is not None:
            node = node.parent
        return node

    def align_root_to(self, target_position: Vec3, target_rotation: Quat) -> None:
        """Rotate then translate the hierarchy's root so this node ends up
        at `target_position`/`target_rotation`."""
        root = self._root()

        rot_delta = q_mul(target_rotation, q_inverse(self._rotation))
        root._rotation = q_normalize(q_mul(rot_delta, root._rotation))
        root._local_rotation = root._rotation  # root has no parent
        root.update_child_transforms_recursive()

        pos_delta = v_sub(target_position, self._position)
        root._position = v_add(root._position, pos_delta)
        root._local_position = root._position
        root.update_child_transforms_recursive()

    def apply_alignment(self, rot_delta: Quat, pos_delta: Vec3) -> None:
        """Apply a world-space alignment delta (rotation then translation)
        to this node. Order matters: the new position is computed from the
        OLD world position, before the new rotation is assigned."""
        new_position = v_add(v_transform(self._position, rot_delta), pos_delta)
        self.rotation = q_normalize(q_mul(rot_delta, self._rotation))
        self.position = new_position

    @staticmethod
    def propagate_world_transforms(nodes: list[TransformTree]) -> None:
        """Propagate world transforms from roots down. Assumes parents
        precede children in `nodes` (glTF joint order guarantees this)."""
        for node in nodes:
            parent = node.parent
            if parent is None:
                node._rotation = node._local_rotation
                node._position = node._local_position
            else:
                node._rotation = q_normalize(
                    q_mul(parent._rotation, node._local_rotation)
                )
                node._position = v_add(
                    parent._position,
                    v_transform(node._local_position, parent._rotation),
                )
