/**
 * Sim control loop — LLM-driven autonomous control of a Genesis world.
 *
 * Each iteration:
 *   1. The model receives the task, the world API description, and the
 *      transcript so far (thoughts, code, results).
 *   2. It replies with JSON: {"thought": "...", "code": "..."} to act,
 *      or {"done": true, "summary": "..."} to finish.
 *   3. The code runs in the persistent world namespace via SimBridge;
 *      the result (stdout / traceback) feeds the next iteration.
 *
 * Budget rails: MOMO_SIM_MAX_STEPS (default 20); 3 consecutive
 * unparseable replies abort the run.
 *
 * @module sim/loop
 */

import { chatComplete, resolveProviderConfig } from "../cli/chat.js"
import { extractJsonObject } from "../refine/propose.js"
import { SimBridge } from "./bridge.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimTurn {
  readonly step: number
  readonly thought: string
  readonly code: string
  readonly stdout: string
  readonly stderr: string
  readonly error?: string
}

export interface SimLoopResult {
  readonly task: string
  readonly done: boolean
  readonly summary: string
  readonly turns: SimTurn[]
  readonly error?: string
}

export interface SimLoopOpts {
  readonly maxSteps?: number
  readonly viewer?: boolean
  readonly backend?: string
  /** Extra context appended to the system prompt (e.g. active goals) */
  readonly extraContext?: string
  /** Called after every executed action so UIs can stream live progress */
  readonly onTurn?: (turn: SimTurn) => void
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(skills: Array<{ file: string; status: string }>, extra?: string): string {
  const skillList =
    skills.length > 0
      ? skills.map((s) => `  - ${s.file}${s.status === "ok" ? "" : " (FAILED to load)"}`).join("\n")
      : "  (none — you can define reusable functions in the world yourself)"

  return `You are an autonomous simulation agent controlling a persistent Genesis physics world (genesis-world ${"1.x"}).

You act by writing Python code. It executes in a PERSISTENT namespace called WORLD — variables you create survive across steps (context as variables).

Available in the namespace:
  gs      — the genesis module (gs.morphs, gs.material, gs.options, ...)
  scene   — the genesis Scene (already created; NOT yet built until you build it)
  step(n) — advance the physics by n steps
  WORLD   — the namespace dict itself

Genesis quick reference:
  - Add entities BEFORE scene.build(): scene.add_entity(gs.morphs.Box(size=..., pos=...)),
    gs.morphs.Sphere(...), gs.morphs.MJCF(file='xml/franka_emika_panda/panda.xml'), etc.
  - Add a ground plane when gravity matters: scene.add_entity(gs.morphs.Plane())
  - scene.build() once, then step(n) to simulate
  - Robot control: robot.get_dofs_position(), robot.control_dofs_position(target, dofs_idx),
    robot.inverse_kinematics(link, pos=..., quat=...), entity.get_pos()/get_quat()
  - Genesis torch tensors: call .cpu() / float() before printing numbers

Cameras (pure rendering objects - they never affect physics):
  - camera_add(name, pos=[x,y,z], lookat=[x,y,z], fov=60) - attach a camera
  - camera_list() / camera_remove(name) / camera_move(name, pos=..., lookat=...)
  - camera_snapshot(name) - render an RGB frame from that camera
  - camera_path_set(name, keyframes=[{t, pos, lookat}, ...]) - a keyframe trajectory;
    the camera follows it automatically as the clock advances
  - camera_path_clear(name) / camera_path_apply()
  Deploying one or several cameras around the robot is a normal task - call
  camera_add(...) for each one you want.

Loaded skills (functions already in the namespace from ~/.momo/sim/skills/):
${skillList}

Protocol — reply with ONLY a JSON object (no prose, no fences):
  {"thought": "reasoning about what to do next", "code": "python to execute"}
or, when the task is complete or impossible:
  {"done": true, "summary": "what was achieved / why it failed"}

Rules:
  - Small steps: observe results before proceeding (print() positions/states)
  - If code errors, read the traceback and fix it — do not repeat the same code
  - Define a world observe() function when useful; it will be called between tasks
  - Prefer reusable functions — they persist and can become skills later
${extra ? `\nAdditional context:\n${extra}` : ""}`
}

// ---------------------------------------------------------------------------
// Action parsing
// ---------------------------------------------------------------------------

export interface SimAction {
  readonly done: boolean
  readonly thought?: string
  readonly code?: string
  readonly summary?: string
}

export function parseSimAction(text: string): SimAction | null {
  const raw = extractJsonObject(text)
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  if (obj.done === true) {
    return {
      done: true,
      summary: typeof obj.summary === "string" ? obj.summary : "(no summary)",
    }
  }
  if (typeof obj.code === "string" && obj.code.trim()) {
    return {
      done: false,
      thought: typeof obj.thought === "string" ? obj.thought : "",
      code: obj.code,
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runSimLoop(
  task: string,
  bridge: SimBridge,
  opts: SimLoopOpts = {},
): Promise<SimLoopResult> {
  const maxSteps =
    opts.maxSteps ?? (Number(process.env.MOMO_SIM_MAX_STEPS || 20) || 20)

  const config = await resolveProviderConfig()
  if (!config || !config.baseUrl) {
    return {
      task,
      done: false,
      summary: "",
      turns: [],
      error: "no provider configured (set MOMO_API_KEY) — run `momo /sim doctor`",
    }
  }

  // Initialize the world
  let skills: Array<{ file: string; status: string }> = []
  try {
    const init = await bridge.initWorld({
      viewer: opts.viewer ?? false,
      ...(opts.backend ? { backend: opts.backend } : {}),
    })
    skills = init.skills_loaded
  } catch (err) {
    return {
      task,
      done: false,
      summary: "",
      turns: [],
      error: `world init failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const system = buildSystemPrompt(skills, opts.extraContext)
  const turns: SimTurn[] = []
  let parseFailures = 0

  for (let step = 1; step <= maxSteps; step++) {
    // Build the user message: task + transcript so far
    const transcript = turns
      .map((t) => {
        const parts = [
          `--- step ${t.step} ---`,
          t.thought ? `thought: ${t.thought}` : "",
          `code:\n${t.code}`,
        ]
        if (t.stdout) parts.push(`stdout:\n${t.stdout.slice(0, 2000)}`)
        if (t.error) parts.push(`error:\n${t.error.slice(0, 2000)}`)
        else if (t.stderr) parts.push(`stderr:\n${t.stderr.slice(0, 1000)}`)
        return parts.filter(Boolean).join("\n")
      })
      .join("\n\n")

    const userMsg = transcript
      ? `Task: ${task}\n\nProgress so far:\n${transcript}\n\nWhat is your next action?`
      : `Task: ${task}\n\nTake your first action.`

    let reply: string
    try {
      reply = await chatComplete({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        system,
        messages: [{ role: "user", content: userMsg }],
        stream: false,
        temperature: 0.4,
        timeout: 180_000,
      })
    } catch (err) {
      return {
        task,
        done: false,
        summary: "",
        turns,
        error: `LLM call failed at step ${step}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const action = parseSimAction(reply)
    if (!action) {
      parseFailures++
      turns.push({
        step,
        thought: "",
        code: "",
        stdout: "",
        stderr: "",
        error: `unparseable model reply (${parseFailures}/3): ${reply.slice(0, 500)}`,
      })
      if (parseFailures >= 3) {
        return { task, done: false, summary: "", turns, error: "model repeatedly failed to follow the action protocol" }
      }
      continue
    }
    parseFailures = 0

    if (action.done) {
      return { task, done: true, summary: action.summary ?? "", turns }
    }

    const result = await bridge.exec(action.code!)
    turns.push({
      step,
      thought: action.thought ?? "",
      code: action.code!,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.error ? { error: result.error } : {}),
    })
    opts.onTurn?.(turns[turns.length - 1])
  }

  return {
    task,
    done: false,
    summary: "",
    turns,
    error: `step budget exhausted (${maxSteps}) — raise MOMO_SIM_MAX_STEPS if needed`,
  }
}
