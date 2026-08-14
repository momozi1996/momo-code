"""
Sensors demo — IMU + RGB-D camera + ContactForce on a Franka scene.

Validates genesis_world.sensors against the official examples/sensors/
API on the local CPU backend. Run:

    momo /sim exec --file=python/genesis_world/examples/sensors_demo.py
"""

import json

from genesis_world import sensors

# --- Scene -------------------------------------------------------------------
plane = scene.add_entity(gs.morphs.Plane())
franka = scene.add_entity(gs.morphs.MJCF(file="xml/franka_emika_panda/panda.xml"))
cube = scene.add_entity(
    gs.morphs.Box(size=(0.04, 0.04, 0.04), pos=(0.5, 0.0, 0.02)),
    surface=gs.surfaces.Default(color=(0.8, 0.2, 0.2)),
)

# --- Sensor registration (must happen before scene.build()) -------------------
sensors.attach_imu(franka, link_name="hand")
sensors.attach_camera("overhead", pos=(1.5, 0.0, 1.2), lookat=(0.4, 0.0, 0.0))
try:
    sensors.attach_contact(franka)
    CONTACT_OK = True
except Exception as e:
    # ContactForce breaks on torch<2.8 (gather dtype bug in Genesis 1.1.2
    # collider) — skip with a warning, upgrade torch to enable.
    print(f"WARNING: contact sensor skipped ({e})")
    CONTACT_OK = False

scene.build()

# Track entities for the structured observation
tracked = {"franka": franka, "cube": cube}

# Move the arm a little so the IMU sees non-zero acceleration
import torch

qpos = franka.inverse_kinematics(
    link=franka.get_link("hand"),
    pos=(0.4, 0.0, 0.3),
    quat=torch.tensor([0.0, 1.0, 0.0, 0.0]),
)
franka.control_dofs_position(qpos[:7], list(range(7)))
step(30)

# --- Structured observation ----------------------------------------------------
obs = sensors.sense()
print("=== structured observation ===")
print(json.dumps(obs, indent=2, default=str)[:3000])

imu = obs["imu"][0]
assert "lin_acc" in imu and "ang_vel" in imu, "IMU reading missing"
assert "rgb" in obs["frames"]["overhead"], "camera snapshot missing"
print("=== SENSORS DEMO OK ===")
