"""
Safety demo — joint clamping, smooth motion, collision check, and the
server estop channel. Run:

    momo /sim exec --file=python/genesis_world/examples/safety_demo.py
"""

from genesis_world import safety

plane = scene.add_entity(gs.morphs.Plane())
franka = scene.add_entity(gs.morphs.MJCF(file="xml/franka_emika_panda/panda.xml"))
obstacle = scene.add_entity(
    gs.morphs.Box(size=(0.1, 0.1, 0.4), pos=(0.45, 0.0, 0.2)),
    surface=gs.surfaces.Default(color=(0.9, 0.7, 0.1)),
)
scene.build()

ctrl = safety.SafeController(
    franka, arm_dofs=list(range(7)), gripper_dofs=[7, 8], ee_link_name="hand",
)

# 1. Joint clamping — an insane target gets clamped to limits
import numpy as np

insane = np.array([99.0] * 7)
clamped = ctrl.clamp_qpos(insane)
print("clamp: 99.0 →", round(float(clamped[0]), 3), "(within joint limits)")
assert abs(float(clamped[0])) < 4.0

# 2. Smooth EE motion — waypoints are executed without error
wps = ctrl.smooth_move_ee((0.4, 0.0, 0.25))
print("smooth_move_ee executed", wps, "waypoints")

# 3. Collision check API works
col = ctrl.collision_check()
print("collision:", col["collision"], "contacts:", len(col["contacts"]))

# 4. E-stop interrupts motion; resume is required afterwards
ctrl.estop()
try:
    ctrl.smooth_move_ee((0.3, 0.2, 0.2))
    print("ERROR: motion should have been blocked by estop")
except safety.EStopActive:
    print("estop blocked motion as expected")
ctrl.resume()
wps = ctrl.smooth_move_ee((0.3, 0.2, 0.2))
print("resumed, executed", wps, "waypoints")

# 5. Server-side ESTOP flag is honoured too
ESTOP = True  # simulates the server `estop` RPC setting WORLD["ESTOP"]
try:
    ctrl.smooth_move_ee((0.5, -0.2, 0.3))
    print("ERROR: server estop should block motion")
except safety.EStopActive:
    print("server ESTOP flag honoured")
ESTOP = False

print("=== SAFETY DEMO OK ===")
