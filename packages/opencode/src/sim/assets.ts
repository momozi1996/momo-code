/**
 * Sim asset catalog — one-click previewable robots and 3D assets.
 *
 * Each asset is a small scene setup script run through the world server's
 * scene/preview: add the entity (before build), build the scene, then the
 * workbench re-exports the mesh for the three.js viewport. The scripts use
 * only the public Genesis API (gs.morphs.*) so they work on any install.
 *
 * @module sim/assets
 */

export interface SimAsset {
  readonly id: string
  readonly name: string
  readonly category: "primitives" | "robots" | "scenes"
  readonly description: string
  /** A python setup script (executed in the world namespace before build). */
  readonly script: string
}

function robotScript(file: string, label: string): string {
  return `# ${label} — MJCF asset bundled with Genesis
robot = scene.add_entity(
    gs.morphs.MJCF(file="${file}"),
)
# optional ground plane for a stable preview
scene.add_entity(gs.morphs.Plane())
scene.build()`
}

export const ASSET_CATALOG: SimAsset[] = [
  {
    id: "box",
    name: "Box",
    category: "primitives",
    description: "Simple rigid box — the fastest scene to preview.",
    script: `# Box primitive
box = scene.add_entity(gs.morphs.Box(size=(0.2, 0.2, 0.2), pos=(0.0, 0.0, 0.2)))
scene.add_entity(gs.morphs.Plane())
scene.build()`,
  },
  {
    id: "sphere",
    name: "Sphere",
    category: "primitives",
    description: "Rigid sphere.",
    script: `# Sphere primitive
ball = scene.add_entity(gs.morphs.Sphere(radius=0.15, pos=(0.0, 0.0, 0.3)))
scene.add_entity(gs.morphs.Plane())
scene.build()`,
  },
  {
    id: "capsule",
    name: "Capsule",
    category: "primitives",
    description: "Rigid capsule.",
    script: `# Capsule primitive
cap = scene.add_entity(gs.morphs.Capsule(radius=0.08, height=0.25, pos=(0.0, 0.0, 0.25)))
scene.add_entity(gs.morphs.Plane())
scene.build()`,
  },
  {
    id: "cylinder",
    name: "Cylinder",
    category: "primitives",
    description: "Rigid cylinder.",
    script: `# Cylinder primitive
cyl = scene.add_entity(gs.morphs.Cylinder(radius=0.08, height=0.3, pos=(0.0, 0.0, 0.25)))
scene.add_entity(gs.morphs.Plane())
scene.build()`,
  },
  {
    id: "panda",
    name: "Franka Panda",
    category: "robots",
    description: "7-DoF Franka Emika Panda arm (MJCF).",
    script: robotScript("xml/franka_emika_panda/panda.xml", "Franka Panda arm"),
  },
  {
    id: "ur5",
    name: "UR5",
    category: "robots",
    description: "Universal Robots UR5 6-DoF arm (MJCF).",
    script: robotScript("xml/ur5/ur5.xml", "UR5 arm"),
  },
  {
    id: "go2",
    name: "Unitree Go2",
    category: "robots",
    description: "Unitree Go2 quadruped (MJCF).",
    script: robotScript("xml/go2/go2.xml", "Unitree Go2"),
  },
  {
    id: "anymal",
    name: "ANYmal C",
    category: "robots",
    description: "ANYbotics ANYmal C quadruped (URDF).",
    script: robotScript("urdf/anymal_c/anymal.urdf", "ANYmal C"),
  },
  {
    id: "robotiq",
    name: "Robotiq 85 gripper",
    category: "robots",
    description: "Robotiq 85 two-finger gripper (MJCF).",
    script: robotScript("xml/robotiq_85/robotiq_85.xml", "Robotiq 85 gripper"),
  },
  {
    id: "panda-table",
    name: "Panda on table",
    category: "scenes",
    description: "Franka arm mounted on a table — a classic pick/place scene.",
    script: `# Panda arm mounted on a table
scene.add_entity(gs.morphs.Plane())
table = scene.add_entity(gs.morphs.Box(size=(0.6, 1.0, 0.05), pos=(0.0, 0.0, 0.5)))
franka = scene.add_entity(
    gs.morphs.MJCF(file="xml/franka_emika_panda/panda.xml"),
)
cube = scene.add_entity(
    gs.morphs.Box(size=(0.05, 0.05, 0.05), pos=(0.35, 0.0, 0.55)),
)
scene.build()`,
  },
]