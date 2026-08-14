"""
genesis_world.safety — safety & smooth-control middleware.

    from genesis_world import safety

    ctrl = safety.SafeController(franka, arm_dofs=list(range(7)),
                                 gripper_dofs=[7, 8], ee_link_name="hand")
    ctrl.smooth_move_ee((0.5, 0.0, 0.1))     # velocity-limited waypoint motion
    ctrl.estop()                              # freeze everything
    ctrl.resume()                             # explicit resume required

Safety rails:
  - Joint targets are clamped to the robot's DOF limits
  - Motion is decomposed into waypoints honouring max_dq per step
  - WORLD["ESTOP"] is checked at every waypoint (server `estop` RPC sets it)
  - collision_check() reports unexpected contacts via the rigid solver collider
"""

import numpy as np

# Injected by the world server at init time.
WORLD = None


def _require_world():
    if WORLD is None or WORLD.get("scene") is None:
        raise RuntimeError("safety module not bound to a world — call init first")
    return WORLD


class EStopActive(RuntimeError):
    """Raised when an emergency stop interrupts a motion."""


class SafeController:
    def __init__(
        self,
        robot,
        arm_dofs,
        gripper_dofs=None,
        ee_link_name=None,
        max_dq=0.05,
        steps_per_waypoint=5,
    ):
        """
        max_dq: max joint-space delta (rad) per waypoint — velocity limit.
        steps_per_waypoint: physics steps between waypoints.
        """
        self.robot = robot
        self.arm_dofs = list(arm_dofs)
        self.gripper_dofs = list(gripper_dofs or [])
        self.ee_link = robot.get_link(ee_link_name) if ee_link_name else None
        self.max_dq = float(max_dq)
        self.steps_per_waypoint = int(steps_per_waypoint)
        self._stopped = False

        limits = robot.get_dofs_limit()
        arr = np.asarray(limits, dtype=float)
        # Genesis returns [n_dofs, 2] or (lower, upper) depending on version
        if arr.ndim == 2 and arr.shape[1] == 2:
            self._lower, self._upper = arr[:, 0], arr[:, 1]
        else:
            self._lower, self._upper = np.asarray(limits[0]), np.asarray(limits[1])

    # ------------------------------------------------------------------
    # Clamping
    # ------------------------------------------------------------------

    def clamp_qpos(self, target):
        """Clamp a full-qpos or arm-only target to joint limits."""
        t = np.asarray(target, dtype=float).copy()
        idx = self.arm_dofs if len(t) == len(self.arm_dofs) else list(range(len(t)))
        for i, d in enumerate(idx):
            lo, hi = self._lower[d], self._upper[d]
            if np.isfinite(lo) and np.isfinite(hi):
                t[i] = min(max(t[i], lo), hi)
        return t

    # ------------------------------------------------------------------
    # E-stop
    # ------------------------------------------------------------------

    def estop(self):
        """Freeze: hold current positions, set the module stop flag."""
        _require_world()["ESTOP"] = True
        self._stopped = True
        current = np.asarray(self.robot.get_dofs_position(), dtype=float).copy()
        all_dofs = self.arm_dofs + self.gripper_dofs
        import torch

        self.robot.control_dofs_position(
            torch.tensor([current[d] for d in all_dofs], dtype=torch.float32),
            all_dofs,
        )
        return {"estop": True}

    def resume(self):
        """Explicit resume — required after any estop."""
        _require_world()["ESTOP"] = False
        self._stopped = False
        return {"estop": False}

    def _check_estop(self):
        if self._stopped or _require_world().get("ESTOP"):
            raise EStopActive("emergency stop active — call resume() to continue")

    # ------------------------------------------------------------------
    # Smooth motion
    # ------------------------------------------------------------------

    def smooth_move(self, target_qpos, steps_per_waypoint=None):
        """
        Move arm joints to a clamped target through velocity-limited
        waypoints. Aborts with EStopActive if ESTOP is raised mid-motion.
        Returns the number of waypoints executed.
        """
        import torch

        self._check_estop()
        target = self.clamp_qpos(target_qpos)
        current = np.asarray(self.robot.get_dofs_position(), dtype=float)[self.arm_dofs]

        delta = target - current
        max_delta = float(np.max(np.abs(delta))) if delta.size else 0.0
        n_waypoints = max(1, int(np.ceil(max_delta / self.max_dq)))
        spw = steps_per_waypoint or self.steps_per_waypoint

        for k in range(1, n_waypoints + 1):
            self._check_estop()
            wp = current + delta * (k / n_waypoints)
            self.robot.control_dofs_position(
                torch.tensor(wp, dtype=torch.float32), self.arm_dofs
            )
            _require_world()["step"](spw)
        return n_waypoints

    def smooth_move_ee(self, pos, quat=None, steps_per_waypoint=None):
        """IK + smooth_move to an end-effector target pose."""
        import torch

        if self.ee_link is None:
            raise RuntimeError("SafeController created without ee_link_name")
        if quat is None:
            quat = torch.tensor([0.0, 1.0, 0.0, 0.0])  # gripper down
        qpos = self.robot.inverse_kinematics(link=self.ee_link, pos=pos, quat=quat)
        return self.smooth_move(
            np.asarray(qpos, dtype=float)[: len(self.arm_dofs)],
            steps_per_waypoint=steps_per_waypoint,
        )

    def gripper(self, close=True, width_closed=0.0, width_open=0.04, steps=15):
        """Open/close the gripper with limit clamping."""
        import torch

        self._check_estop()
        if not self.gripper_dofs:
            raise RuntimeError("SafeController created without gripper_dofs")
        width = width_closed if close else width_open
        self.robot.control_dofs_position(
            torch.tensor([width] * len(self.gripper_dofs), dtype=torch.float32),
            self.gripper_dofs,
        )
        _require_world()["step"](steps)

    # ------------------------------------------------------------------
    # Collision monitoring
    # ------------------------------------------------------------------

    def collision_check(self, ignore_floor=True):
        """
        Inspect scene contacts involving the robot.
        Returns {"collision": bool, "contacts": [...]} — floor contacts
        are ignored by default (the robot base always touches the plane).
        """
        scene = _require_world()["scene"]
        contacts = scene.sim.rigid_solver.collider.get_contacts(as_tensor=False)
        if len(contacts.get("link_a", [])) == 0:
            return {"collision": False, "contacts": []}

        # Map global link indices -> owning entity name.
        link_owner = {}
        for ent in scene.entities:
            for link in getattr(ent, "links", []):
                link_owner[int(link.idx)] = getattr(link, "name", "")

        robot_links = {int(l.idx) for l in self.robot.links}
        hits = []
        for a, b, pos, force in zip(
            contacts["link_a"],
            contacts["link_b"],
            contacts["position"],
            contacts["force"],
        ):
            a, b = int(a), int(b)
            if a not in robot_links and b not in robot_links:
                continue  # not involving the robot
            other = b if a in robot_links else a
            other_name = link_owner.get(other, f"link#{other}")
            if other in robot_links:
                continue  # self-collision of adjacent links is normal
            if ignore_floor and "plane" in other_name.lower():
                continue
            hits.append(
                {
                    "robot_link": link_owner.get(a if a in robot_links else b, ""),
                    "other": other_name,
                    "position": [round(float(v), 4) for v in pos],
                    "force": round(float(force.norm()), 3),
                }
            )
        return {"collision": len(hits) > 0, "contacts": hits}
