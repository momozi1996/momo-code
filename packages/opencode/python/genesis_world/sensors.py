"""
genesis_world.sensors — sensor registration and structured observation.

Wraps the Genesis 1.x sensor stack (same API as the official
examples/sensors/ demos) behind a small, agent-friendly surface:

    from genesis_world import sensors

    sensors.attach_imu(franka, link_name="hand")
    sensors.attach_camera("overhead", pos=(1.5, 0, 1.5), lookat=(0.5, 0, 0))
    sensors.attach_contact(franka)
    obs = sensors.sense()            # structured observation dict
    path = sensors.snapshot("overhead")

Camera backend is the Rasterizer (the only CPU-viable backend; switch to
Raytracer/BatchRenderer once a CUDA torch is installed).

Registered sensors live in the module-level _SENSORS registry, which is
per-world (reset on world reset, since modules are re-imported per
process and each CLI invocation owns one process).
"""

import os

import numpy as np

# Injected by the world server at init time — the persistent exec namespace.
WORLD = None

_SENSORS = {"imu": [], "camera": {}, "contact": []}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _gs():
    import genesis as gs  # lazy — heavy import

    return gs


def _require_world():
    if WORLD is None or WORLD.get("scene") is None:
        raise RuntimeError("sensors module not bound to a world — call init first")
    return WORLD


def _to_list(x, n=None, digits=4):
    arr = np.asarray(x, dtype=float).flatten()
    if n is not None:
        arr = arr[:n]
    return [round(float(v), digits) for v in arr]


def _frames_dir():
    home = os.environ.get("MOMO_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".momo"
    )
    out = os.path.join(home, "sim", "frames")
    os.makedirs(out, exist_ok=True)
    return out


# ---------------------------------------------------------------------------
# IMU  (reference: examples/sensors/imu_franka.py)
# ---------------------------------------------------------------------------


def attach_imu(entity, link_name, pos_offset=(0.0, 0.0, 0.1), noise=True):
    """
    Register an IMU on `entity`'s link `link_name`.
    With noise=True, uses the official example's realistic noise model
    (cross-axis coupling, white noise, random walk, delay, jitter).
    Returns the sensor index used with `read_imu()`.
    """
    gs = _gs()
    link = entity.get_link(link_name)
    kwargs = dict(
        entity_idx=entity.idx,
        link_idx_local=link.idx_local,
        pos_offset=pos_offset,
    )
    if noise:
        kwargs.update(
            acc_cross_axis_coupling=(0.0, 0.01, 0.02),
            gyro_cross_axis_coupling=(0.03, 0.04, 0.05),
            acc_noise=(0.01, 0.01, 0.01),
            gyro_noise=(0.01, 0.01, 0.01),
            acc_random_walk=(0.001, 0.001, 0.001),
            gyro_random_walk=(0.001, 0.001, 0.001),
            delay=0.01,
            jitter=0.01,
        )
    imu = _require_world()["scene"].add_sensor(gs.sensors.IMU(**kwargs))
    _SENSORS["imu"].append(imu)
    return len(_SENSORS["imu"]) - 1


def read_imu(index=0, ground_truth=True):
    """Read IMU `index` → {lin_acc, ang_vel, (optionally) ground-truth + bias}."""
    imu = _SENSORS["imu"][index]
    data = imu.read()
    out = {
        "lin_acc": _to_list(data.lin_acc, 3),
        "ang_vel": _to_list(data.ang_vel, 3),
    }
    if ground_truth:
        gt = imu.read_ground_truth()
        out["true_lin_acc"] = _to_list(gt.lin_acc, 3)
        out["true_ang_vel"] = _to_list(gt.ang_vel, 3)
    return out


# ---------------------------------------------------------------------------
# RGB-D camera  (reference: examples/sensors/camera_as_sensor.py)
# ---------------------------------------------------------------------------


def attach_camera(
    name,
    pos,
    lookat,
    fov=60.0,
    res=(320, 240),
    up=(0.0, 0.0, 1.0),
    near=0.1,
    far=100.0,
    attach_to=None,
    link_name=None,
    pos_offset=(0.0, 0.0, 0.0),
    lights=None,
):
    """
    Register a Rasterizer camera sensor named `name`.
    Fixed camera: pass pos/lookat. Attached camera: pass
    attach_to=<entity> and link_name=<link> (rides the link).
    Resolution defaults low (320x240) — CPU rendering is slow.
    """
    gs = _gs()
    from genesis.options.sensors import RasterizerCameraOptions

    kwargs = dict(
        res=res,
        pos=pos,
        lookat=lookat,
        up=up,
        fov=fov,
        near=near,
        far=far,
        lights=lights if lights is not None else [{"pos": (2.0, 2.0, 5.0), "color": (1.0, 1.0, 1.0), "intensity": 1.5}],
    )
    if attach_to is not None:
        kwargs["entity_idx"] = attach_to.idx
        if link_name is not None:
            kwargs["link_idx_local"] = attach_to.get_link(link_name).idx_local
        kwargs["pos_offset"] = pos_offset

    cam = _require_world()["scene"].add_sensor(RasterizerCameraOptions(**kwargs))
    _SENSORS["camera"][name] = cam
    return name


def _read_camera(cam):
    """Normalize the camera read() result across Genesis versions."""
    data = cam.read()
    rgb = depth = None
    if hasattr(data, "rgb"):
        rgb = data.rgb
    if hasattr(data, "depth"):
        depth = data.depth
    if rgb is None and isinstance(data, (tuple, list)):
        rgb = data[0] if len(data) > 0 else None
        depth = data[1] if len(data) > 1 else None
    if rgb is None and isinstance(data, dict):
        rgb = data.get("rgb")
        depth = data.get("depth")
    return rgb, depth


def snapshot(name, prefix=None):
    """
    Render one frame from camera `name`; save RGB (PNG) and depth (NPY)
    under ~/.momo/sim/frames/. Returns {"rgb": path, "depth": path|None}.
    """
    cam = _SENSORS["camera"][name]
    rgb, depth = _read_camera(cam)

    out = {}
    stamp = f"{prefix or name}"
    if rgb is not None:
        from PIL import Image

        arr = np.asarray(rgb)
        if arr.dtype != np.uint8:
            arr = np.clip(arr, 0, 255).astype(np.uint8)
        path = os.path.join(_frames_dir(), f"{stamp}.png")
        Image.fromarray(arr).save(path)
        out["rgb"] = path
    if depth is not None:
        dpath = os.path.join(_frames_dir(), f"{stamp}_depth.npy")
        np.save(dpath, np.asarray(depth))
        out["depth"] = dpath
    if not out:
        raise RuntimeError(f"camera '{name}' returned no usable frame data")
    return out


# ---------------------------------------------------------------------------
# Contact force
# ---------------------------------------------------------------------------


def _torch_at_least(major, minor):
    try:
        import torch

        parts = torch.__version__.split(".")
        return (int(parts[0]), int(parts[1])) >= (major, minor)
    except Exception:
        return True  # unknown — let Genesis handle it


def attach_contact(entity, link_name=None, min_force=0.0, max_force=1000.0):
    """
    Register a ContactForce sensor on `entity` (optionally one link).
    Returns the sensor index used with `read_contacts()`.

    Requires torch>=2.8 — Genesis 1.1.2's collider hits a gather() dtype
    bug on older torch versions (crashes inside scene.step()).
    """
    if not _torch_at_least(2, 8):
        import torch

        raise RuntimeError(
            f"ContactForce sensor requires torch>=2.8 with Genesis 1.1.2 "
            f"(found {torch.__version__}) — upgrade torch to enable contact sensing"
        )
    gs = _gs()
    kwargs = dict(entity_idx=entity.idx, min_force=min_force, max_force=max_force)
    if link_name is not None:
        kwargs["link_idx_local"] = entity.get_link(link_name).idx_local
    sensor = _require_world()["scene"].add_sensor(gs.sensors.ContactForce(**kwargs))
    _SENSORS["contact"].append(sensor)
    return len(_SENSORS["contact"]) - 1


def read_contacts(index=0):
    """Read ContactForce sensor `index` → {"force": [fx, fy, fz], "magnitude": float}."""
    sensor = _SENSORS["contact"][index]
    data = sensor.read()
    vec = getattr(data, "force", data)
    arr = np.asarray(vec, dtype=float).flatten()[-3:]
    return {
        "force": _to_list(arr, 3),
        "magnitude": round(float(np.linalg.norm(arr)), 4),
    }


# ---------------------------------------------------------------------------
# Structured observation — the decision layer's standard input
# ---------------------------------------------------------------------------


def sense(entities=None, include_vision=False, vision_labels=None):
    """
    Aggregate a structured observation:
      - entities: {name: pose/velocity} for each tracked entity
      - imu: readings for every registered IMU
      - contacts: readings for every ContactForce sensor
      - frames: fresh snapshot paths for every camera
      - vision: CLIP labels per camera (only when include_vision is a
        list of candidate labels — see genesis_world.perception)

    `entities` may be a dict {name: entity} — defaults to WORLD["tracked"].
    """
    obs = {"imu": [], "contacts": [], "frames": {}}

    tracked = entities or (WORLD or {}).get("tracked") or {}
    obs["entities"] = {
        name: {
            "pos": _to_list(ent.get_pos(), 3),
            "quat": _to_list(ent.get_quat(), 4),
            "vel": _to_list(ent.get_vel(), 3),
        }
        for name, ent in tracked.items()
    }

    for i in range(len(_SENSORS["imu"])):
        try:
            obs["imu"].append(read_imu(i))
        except Exception as e:  # sensor may not have data yet
            obs["imu"].append({"error": str(e)})

    for i in range(len(_SENSORS["contact"])):
        try:
            obs["contacts"].append(read_contacts(i))
        except Exception as e:
            obs["contacts"].append({"error": str(e)})

    for cam_name in _SENSORS["camera"]:
        try:
            obs["frames"][cam_name] = snapshot(cam_name)
        except Exception as e:
            obs["frames"][cam_name] = {"error": str(e)}

    if include_vision and vision_labels:
        try:
            from genesis_world import perception

            obs["vision"] = {
                cam_name: perception.label_image(paths["rgb"], vision_labels)
                for cam_name, paths in obs["frames"].items()
                if isinstance(paths, dict) and "rgb" in paths
            }
        except Exception as e:
            obs["vision"] = {"error": str(e)}

    return obs
