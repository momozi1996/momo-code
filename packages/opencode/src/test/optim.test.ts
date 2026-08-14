import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  assertParamConsistent,
  bestTrial,
  createStudy,
  lastNote,
  listStudies,
  loadStudy,
  nextTrialNumber,
  parseParamSpec,
  readTrials,
  appendTrial,
  type ParamSpec,
  type StudyConfig,
  type TrialRecord,
} from "../optim/study"
import {
  MockSampler,
  RandomSampler,
  extractProposal,
  mulberry32,
  sampleRandomPoint,
  validateParams,
} from "../optim/sampler"
import { parseMetric, substituteParams } from "../optim/evaluate"
import { normalizeSemantics, renderSemanticsMarkdown } from "../optim/semantics"
import { runStudy } from "../optim/runner"

// ---------------------------------------------------------------------------
// Isolation (MOMO_CONFIG_DIR → tmp)
// ---------------------------------------------------------------------------

let tmp: string
let saved: string | undefined

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-optim-"))
  saved = process.env.MOMO_CONFIG_DIR
  process.env.MOMO_CONFIG_DIR = tmp
})

after(() => {
  if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
  else process.env.MOMO_CONFIG_DIR = saved
  fs.rmSync(tmp, { recursive: true, force: true })
})

const SPACE: readonly ParamSpec[] = [
  { name: "x", type: "float", low: -5, high: 5 },
  { name: "n", type: "int", low: 1, high: 10 },
  { name: "model", type: "categorical", choices: ["a", "b", "c"] },
]

function makeConfig(name: string): StudyConfig {
  return createStudy({
    name,
    direction: "minimize",
    space: SPACE,
    metric: "metric",
    evaluator: { kind: "cmd", cmd: "true" },
  })
}

function trial(number: number, value: number, extra: Partial<TrialRecord> = {}): TrialRecord {
  return {
    number,
    params: { x: value },
    state: "complete",
    ts: new Date().toISOString(),
    value,
    ...extra,
  }
}

// ---------------------------------------------------------------------------
// parseParamSpec
// ---------------------------------------------------------------------------

describe("optim/study parseParamSpec", () => {
  it("parses float, log, int, categorical specs", () => {
    assert.deepStrictEqual(parseParamSpec("lr:1e-5:1e-1:log"), {
      name: "lr", type: "float", low: 1e-5, high: 1e-1, log: true,
    })
    assert.deepStrictEqual(parseParamSpec("threshold:0.05:0.95"), {
      name: "threshold", type: "float", low: 0.05, high: 0.95,
    })
    assert.deepStrictEqual(parseParamSpec("depth:2:8:int,log"), {
      name: "depth", type: "int", low: 2, high: 8, log: true,
    })
    assert.deepStrictEqual(parseParamSpec("model:a,b,c"), {
      name: "model", type: "categorical", choices: ["a", "b", "c"],
    })
  })

  it("rejects invalid specs loudly", () => {
    assert.throws(() => parseParamSpec("x:5:1"), /low must be < high/)
    assert.throws(() => parseParamSpec("x:0:1:log"), /log scale requires low > 0/)
    assert.throws(() => parseParamSpec("x:a:b"), /Invalid bounds/)
    assert.throws(() => parseParamSpec("x:onlyone"), /≥2/)
    assert.throws(() => parseParamSpec("x:1:2:bogus"), /Unknown flag/)
  })
})

// ---------------------------------------------------------------------------
// study persistence
// ---------------------------------------------------------------------------

describe("optim/study persistence", () => {
  it("creates, loads, lists studies", () => {
    const config = makeConfig("s1")
    assert.strictEqual(config.direction, "minimize")
    const loaded = loadStudy("s1")
    assert.strictEqual(loaded?.name, "s1")
    assert.ok(listStudies().includes("s1"))
    assert.throws(() => makeConfig("s1"), /already exists/)
  })

  it("appends and reads trials in order", () => {
    makeConfig("s2")
    appendTrial("s2", trial(0, 1.5, { reasoning: "warmup" }))
    appendTrial("s2", trial(1, 0.5, { note: "lower is better near x=0" }))
    const trials = readTrials("s2")
    assert.strictEqual(trials.length, 2)
    assert.strictEqual(nextTrialNumber(trials), 2)
    assert.strictEqual(lastNote(trials), "lower is better near x=0")
  })

  it("bestTrial respects direction", () => {
    const trials = [trial(0, 3), trial(1, 1), trial(2, 2)]
    assert.strictEqual(bestTrial("minimize", trials)?.number, 1)
    assert.strictEqual(bestTrial("maximize", trials)?.number, 0)
    assert.strictEqual(bestTrial("minimize", []), null)
  })

  it("assertParamConsistent raises on drift", () => {
    const space = [parseParamSpec("x:0:1")]
    assert.doesNotThrow(() => assertParamConsistent(space, parseParamSpec("x:0:1")))
    assert.throws(() => assertParamConsistent(space, parseParamSpec("x:0:2")), /bounds changed/)
    assert.throws(() => assertParamConsistent(space, parseParamSpec("y:0:1")), /Unknown parameter/)
  })
})

// ---------------------------------------------------------------------------
// sampler: validation & extraction
// ---------------------------------------------------------------------------

describe("optim/sampler validation", () => {
  it("clamps numeric values into range and rounds ints", () => {
    const out = validateParams({ x: 99, n: 3.6, model: "b" }, SPACE)
    assert.strictEqual(out.x, 5)
    assert.strictEqual(out.n, 4)
    assert.strictEqual(out.model, "b")
  })

  it("rejects NaN, wrong categorical, missing params", () => {
    assert.throws(() => validateParams({ x: NaN, n: 1, model: "a" }, SPACE), /finite number/)
    assert.throws(() => validateParams({ x: 0, n: 1, model: "zzz" }, SPACE), /one of/)
    assert.throws(() => validateParams({ x: 0, model: "a" }, SPACE), /missing parameter "n"/)
  })

  it("extractProposal parses JSON with reasoning and note", () => {
    const reply = `Here is my choice:\n\`\`\`json\n{"params":{"x":1.5,"n":3,"model":"a"},"_reasoning":"probe the center","_note":"bowl-shaped so far"}\n\`\`\``
    const p = extractProposal(reply, SPACE)
    assert.strictEqual(p.params.x, 1.5)
    assert.strictEqual(p.reasoning, "probe the center")
    assert.strictEqual(p.note, "bowl-shaped so far")
  })

  it("extractProposal throws on garbage", () => {
    assert.throws(() => extractProposal("no json here", SPACE))
    assert.throws(() => extractProposal('{"params":{"x":0}}', SPACE), /missing/)
  })
})

describe("optim/sampler random & mock", () => {
  it("sampleRandomPoint stays in bounds and honors categorical", () => {
    const rand = mulberry32(7)
    for (let i = 0; i < 50; i++) {
      const p = sampleRandomPoint(SPACE, rand)
      assert.ok((p.x as number) >= -5 && (p.x as number) <= 5)
      assert.ok(Number.isInteger(p.n))
      assert.ok(["a", "b", "c"].includes(p.model as string))
    }
  })

  it("RandomSampler always proposes valid fallback points", async () => {
    makeConfig("s3")
    const s = new RandomSampler(1)
    const p = await s.propose({ config: loadStudy("s3")!, trials: [] })
    assert.strictEqual(p.fallback, true)
    validateParams(p.params, SPACE)
  })
})

// ---------------------------------------------------------------------------
// evaluate: pure helpers
// ---------------------------------------------------------------------------

describe("optim/evaluate helpers", () => {
  it("substitutes {param} placeholders", () => {
    assert.strictEqual(
      substituteParams("python t.py --lr {lr} --tag {tag}", { lr: 0.1, tag: "x" }),
      "python t.py --lr 0.1 --tag x",
    )
    assert.strictEqual(substituteParams("echo {missing}", {}), "echo {missing}")
  })

  it("parses metric from key=value lines (last wins)", () => {
    assert.strictEqual(parseMetric("metric=1.5\nmetric=0.25\n", "metric"), 0.25)
    assert.strictEqual(parseMetric("  score = -3.5 ", "score"), -3.5)
  })

  it("parses metric from a JSON line", () => {
    assert.strictEqual(parseMetric('noise\n{"metric": 0.75}', "metric"), 0.75)
    assert.throws(() => parseMetric("nothing useful", "metric"), /not found/)
  })
})

// ---------------------------------------------------------------------------
// semantics: normalize & render
// ---------------------------------------------------------------------------

describe("optim/semantics", () => {
  it("normalizes LLM output, placeholders for missing params", () => {
    const map = normalizeSemantics(
      {
        params: { x: { context: "position on the x axis", unit: "m" }, model: "which backend" },
        interactions: "x and n couple multiplicatively",
      },
      "src/thing.py",
      SPACE,
    )
    assert.strictEqual(map.status, "draft")
    assert.strictEqual(map.params.x.context, "position on the x axis")
    assert.strictEqual(map.params.x.unit, "m")
    assert.strictEqual(map.params.model.context, "which backend")
    assert.match(map.params.n.context, /not inferred/)
    assert.strictEqual(map.interactions, "x and n couple multiplicatively")
  })

  it("renders a readable markdown map", () => {
    const map = normalizeSemantics({ params: { x: "the x knob" } }, "t.py", SPACE)
    const md = renderSemanticsMarkdown(map)
    assert.match(md, /Parameter Semantics/)
    assert.match(md, /the x knob/)
    assert.match(md, /draft/)
  })
})

// ---------------------------------------------------------------------------
// runner: full loop with MockSampler (offline)
// ---------------------------------------------------------------------------

describe("optim/runner (mock sampler, offline)", () => {
  it("converges near the quadratic-bowl minimum within 20 trials", async () => {
    // objective (x-1)^2 computed offline by node, reading the OPTIM_X env
    // var that the cmd evaluator exports (avoids shell-quoting pitfalls)
    const objectiveFile = path.join(tmp, "objective-bowl.js").replace(/\\/g, "/")
    fs.writeFileSync(
      objectiveFile,
      `console.log("metric=" + Math.pow(Number(process.env.OPTIM_X) - 1, 2))`,
      "utf-8",
    )
    const config = createStudy({
      name: "bowl",
      direction: "minimize",
      space: [{ name: "x", type: "float", low: -5, high: 5 }],
      metric: "metric",
      evaluator: { kind: "cmd", cmd: `node ${objectiveFile}` },
    })

    const result = await runStudy(config, {
      trials: 20,
      sampler: new MockSampler(11),
      nInit: 2,
    })
    assert.strictEqual(result.ran, 20)
    const trials = readTrials("bowl")
    assert.strictEqual(trials.length, 20)
    assert.ok(trials.every((t) => t.state === "complete"))
    // hill-climbing with 10%-span jitter must get well under the warmup draws
    assert.ok(result.best !== null, "expected a best trial")
    assert.ok(
      result.best!.value! < 1.0,
      `expected convergence below 1.0, got ${result.best!.value}`,
    )
  })

  it("records failed trials into history (agent learns from failures)", async () => {
    const config = createStudy({
      name: "failing",
      direction: "maximize",
      space: [{ name: "x", type: "float", low: 0, high: 1 }],
      metric: "metric",
      evaluator: { kind: "cmd", cmd: "echo no-metric-here" },
    })
    const result = await runStudy(config, { trials: 3, sampler: new MockSampler(3), nInit: 0 })
    assert.strictEqual(result.best, null)
    const trials = readTrials("failing")
    assert.strictEqual(trials.length, 3)
    assert.ok(trials.every((t) => t.state === "failed"))
  })

  it("completes trials when the evaluator emits a metric", async () => {
    const config = createStudy({
      name: "echo",
      direction: "maximize",
      space: [{ name: "x", type: "float", low: 0, high: 1 }],
      metric: "metric",
      evaluator: { kind: "cmd", cmd: "echo metric=0.5" },
    })
    const result = await runStudy(config, { trials: 4, sampler: new MockSampler(5), nInit: 0 })
    assert.strictEqual(result.ran, 4)
    assert.strictEqual(result.best?.value, 0.5)
    const trials = readTrials("echo")
    assert.strictEqual(trials.filter((t) => t.state === "complete").length, 4)
  })
})
