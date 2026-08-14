"""
Franka pick-and-place — reference scenario for the generic world framework.

Run inside a world session, e.g.:

    momo /sim exec "$(cat packages/opencode/python/genesis_world/examples/pick_and_place.py)"

or paste the code into an LLM-driven session as a starting point.
Assumes the world namespace provides: gs, scene, step(n).
"""

# ---------------------------------------------------------------------------
# Scene setup (must happen before scene.build())
# ---------------------------------------------------------------------------

plane = scene.add_entity(gs.morphs.Plane())

cube_a = scene.add_entity(
    gs.morphs.Box(size=(0.04, 0.04, 0.04), pos=(0.5, 0.0, 0.02)),
    surface=gs.surfaces.Default(color=(0.8, 0.2, 0.2)),
)
cube_b = scene.add_entity(
    gs.morphs.Box(size=(0.04, 0.04, 0.04), pos=(0.3, 0.3, 0.02)),
    surface=gs.surfaces.Default(color=(0.2, 0.2, 0.8)),
)

franka = scene.add_entity(gs.morphs.MJCF(file="xml/franka_emika_panda/panda.xml"))

scene.build()

# ---------------------------------------------------------------------------
# Reusable skills — functions defined here persist in the world namespace
# ---------------------------------------------------------------------------

import torch

n_dofs = franka.n_dofs
arm_dofs = list(range(7))
gripper_dofs = [7, 8]
ee_link = franka.get_link("hand")


def move_ee_to(pos, quat=None, steps=30):
    """Move the end-effector to a target position via IK + position control."""
    if quat is None:
        quat = torch.tensor([0.0, 1.0, 0.0, 0.0])  # gripper facing down
    qpos = franka.inverse_kinematics(link=ee_link, pos=pos, quat=quat)
    franka.control_dofs_position(qpos[:7], arm_dofs)
    step(steps)


def gripper(close=True, steps=15):
    """Close or open the gripper."""
    target = [0.0, 0.0] if close else [0.04, 0.04]
    franka.control_dofs_position(torch.tensor(target), gripper_dofs)
    step(steps)


def observe():
    """World observation hook — the /sim loop calls this between actions."""
    return {
        "ee_pos": [round(float(v), 3) for v in ee_link.get_pos()],
        "cube_a": [round(float(v), 3) for v in cube_a.get_pos()],
        "cube_b": [round(float(v), 3) for v in cube_b.get_pos()],
    }


# ---------------------------------------------------------------------------
# Pick cube A and place it on top of cube B
# ---------------------------------------------------------------------------

gripper(close=False)
move_ee_to((0.5, 0.0, 0.15))      # hover above cube A
move_ee_to((0.5, 0.0, 0.045))     # descend
gripper(close=True)               # grasp
move_ee_to((0.5, 0.0, 0.25))      # lift
move_ee_to((0.3, 0.3, 0.25))      # travel above cube B
move_ee_to((0.3, 0.3, 0.10))      # lower onto cube B
gripper(close=False)              # release
move_ee_to((0.3, 0.3, 0.25))      # retreat

print("final state:", observe())
