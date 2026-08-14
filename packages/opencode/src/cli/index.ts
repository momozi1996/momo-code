/**
 * MOMO CODE - CLI command router
 */
import { Effect } from "effect"
import { createRequire } from "module"
import { AuthLive } from "../auth.js"
import { printHelp } from "./help.js"
import { runEvolveCommand } from "./cmd/evolve.js"
import { runFinetuneCommand } from "./cmd/finetune.js"
import { runModelsCommand } from "./cmd/models.js"
import { runRefineCommand } from "./cmd/refine.js"
import { runAgentCommand } from "./cmd/agent.js"
import { runGraphCommand } from "./cmd/graph.js"
import { runGoalCommand } from "./cmd/goal.js"
import { runScheduleCommand } from "./cmd/schedule.js"
import { runHeartbeatCommand } from "./cmd/heartbeat.js"
import { runDaemonCommand } from "./cmd/daemon.js"
import { runSimCommand } from "./cmd/sim.js"
import { runVoiceCommand } from "./cmd/voice.js"
import { runOptimCommand } from "./cmd/optim.js"
import { runServeCommand } from "./cmd/serve.js"
import { runChat } from "./chat.js"

const require = createRequire(import.meta.url)

const HELP_FLAGS = new Set(["help", "--help", "-h"])
const VERSION_FLAGS = new Set(["version", "--version", "-v"])

export async function runCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || HELP_FLAGS.has(argv[0])) {
    printHelp()
    return
  }

  if (VERSION_FLAGS.has(argv[0])) {
    showVersion()
    return
  }

// Parse --model / --provider / -m / -p options
  let parsedModel: string | undefined
  let parsedProvider: string | undefined
  const remaining: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === "--model" || arg === "-m") && i + 1 < argv.length) {
      parsedModel = argv[++i]
    } else if ((arg === "--provider" || arg === "-p") && i + 1 < argv.length) {
      parsedProvider = argv[++i]
    } else {
      remaining.push(arg)
    }
  }

  // Apply parsed options to environment variables for downstream consumption
  if (parsedModel) process.env.MOMO_MODEL = parsedModel
  if (parsedProvider) process.env.MOMO_PROVIDER = parsedProvider

  const cmd = remaining[0]
  const args = remaining.slice(1)

  switch (cmd) {
    case "/evolve":
    case "evolve":
      await runEvolveCommand(args)
      break
    case "/fine-tune":
    case "/finetune":
    case "fine-tune":
    case "finetune":
      runFinetuneCommand(args)
      break
    case "/refine":
    case "refine":
      await runRefineCommand(args)
      break
    case "/agent":
    case "agent":
      await runAgentCommand(args)
      break
    case "/graph":
    case "graph":
      await runGraphCommand(args)
      break
    case "/goal":
    case "goal":
      runGoalCommand(args)
      break
    case "/schedule":
    case "schedule":
      runScheduleCommand(args)
      break
    case "/heartbeat":
    case "heartbeat":
      await runHeartbeatCommand(args)
      break
    case "/daemon":
    case "daemon":
      await runDaemonCommand(args)
      break
    case "/sim":
    case "sim":
      await runSimCommand(args)
      break
    case "/voice":
    case "voice":
      await runVoiceCommand(args)
      break
    case "/optim":
    case "optim":
      await runOptimCommand(args)
      break
    case "/serve":
    case "serve":
      await runServeCommand(args)
      break
    case "models":
      await Effect.runPromise(
        runModelsCommand(args).pipe(
          Effect.provide(AuthLive),
          Effect.catchAll((err) => Effect.sync(() => {
            console.error("Error:", err instanceof Error ? err.message : String(err))
            process.exit(1)
          })),
        ),
      )
      break
    default:
      const prompt = [cmd, ...args].join(" ")
      const code = await runChat(prompt)
      if (code !== 0) process.exit(code)
      return
  }
}

function showVersion(): void {
  try {
    const { version } = require("../../package.json")
    console.log(version || "0.1.0")
  } catch {
    console.log("0.1.0")
  }
}
