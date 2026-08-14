import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  saveProposal,
  loadProposal,
  listProposals,
  updateProposalStatus,
  type RefineProposal,
} from "../refine/store"
import { extractJsonObject, normalizeProposals } from "../refine/propose"

function makeProposal(id: string, status: RefineProposal["status"] = "pending"): RefineProposal {
  return {
    id,
    ts: new Date().toISOString(),
    type: "prompt_patch",
    status,
    evidence: ["ses_1"],
    rationale: "because",
    title: `proposal ${id}`,
    patch: "do better",
  }
}

describe("refine/store", () => {
  let tmpDir: string
  let saved: string | undefined

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-refine-"))
    saved = process.env.MOMO_CONFIG_DIR
    process.env.MOMO_CONFIG_DIR = tmpDir
  })

  after(() => {
    if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
    else process.env.MOMO_CONFIG_DIR = saved
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("saves and loads a proposal", () => {
    saveProposal(makeProposal("prop_a"))
    const p = loadProposal("prop_a")
    assert.ok(p)
    assert.strictEqual(p.title, "proposal prop_a")
    assert.strictEqual(p.status, "pending")
  })

  it("returns null for missing proposals", () => {
    assert.strictEqual(loadProposal("prop_missing"), null)
  })

  it("lists proposals with optional status filter", () => {
    saveProposal(makeProposal("prop_b"))
    saveProposal(makeProposal("prop_c", "approved"))
    assert.strictEqual(listProposals().length, 3)
    assert.strictEqual(listProposals("pending").length, 2)
    assert.strictEqual(listProposals("approved").length, 1)
  })

  it("updates status and sets appliedAt", () => {
    const p = updateProposalStatus("prop_a", "applied")
    assert.ok(p)
    assert.strictEqual(p.status, "applied")
    assert.ok(p.appliedAt)
    assert.strictEqual(loadProposal("prop_a")?.status, "applied")
  })
})

describe("refine/propose parsing", () => {
  it("extracts a JSON object from prose-wrapped output", () => {
    const text = 'Here is my review:\n```json\n{"proposals": []}\n```\nDone.'
    const obj = extractJsonObject(text) as { proposals: unknown[] }
    assert.ok(obj)
    assert.deepStrictEqual(obj.proposals, [])
  })

  it("handles nested braces inside strings", () => {
    const text = '{"proposals": [{"patch": "use } braces { carefully"}]}'
    const obj = extractJsonObject(text) as { proposals: Array<{ patch: string }> }
    assert.strictEqual(obj.proposals[0].patch, "use } braces { carefully")
  })

  it("returns null when no JSON present", () => {
    assert.strictEqual(extractJsonObject("no json here"), null)
  })

  it("normalizes valid tactic proposals", () => {
    const proposals = normalizeProposals({
      proposals: [
        {
          type: "tactic",
          title: "Run tests after edits",
          intent: "fix",
          rationale: "sessions show repeated test failures",
          evidence: ["ses_1", "ses_2"],
          steps: ["edit code", "run npm test"],
          checks: ["npm test"],
        },
      ],
    })
    assert.strictEqual(proposals.length, 1)
    assert.strictEqual(proposals[0].type, "tactic")
    assert.strictEqual(proposals[0].status, "pending")
    assert.strictEqual(proposals[0].tactic?.intent, "fix")
    assert.deepStrictEqual(proposals[0].evidence, ["ses_1", "ses_2"])
  })

  it("rejects proposals without evidence", () => {
    const proposals = normalizeProposals({
      proposals: [
        {
          type: "prompt_patch",
          title: "x",
          rationale: "y",
          evidence: [],
          patch: "z",
        },
      ],
    })
    assert.strictEqual(proposals.length, 0)
  })

  it("rejects invalid intent and defaults to workflow", () => {
    const proposals = normalizeProposals({
      proposals: [
        {
          type: "tactic",
          title: "t",
          intent: "bogus",
          rationale: "r",
          evidence: ["ses_1"],
          steps: ["s"],
        },
      ],
    })
    assert.strictEqual(proposals[0].tactic?.intent, "workflow")
  })

  it("caps proposals at 5", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      type: "prompt_patch",
      title: `t${i}`,
      rationale: "r",
      evidence: ["ses_1"],
      patch: "p",
    }))
    assert.strictEqual(normalizeProposals({ proposals: many }).length, 5)
  })
})
