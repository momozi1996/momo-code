/**
 * /voice command — voice input for momo.
 *
 *   momo /voice [--seconds=5] [--lang=zh]   Record → transcribe → run as prompt
 *   momo /voice --file=audio.mp3            Transcribe a file → run as prompt
 *   momo /voice transcribe --file=x.wav     Transcribe only (print text)
 *
 * Recording uses the bundled Python recorder (sounddevice).
 * STT uses an OpenAI-compatible /audio/transcriptions endpoint
 * (MOMO_STT_API_KEY / MOMO_STT_BASE_URL / MOMO_STT_MODEL).
 */
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { recordAudio } from "../../voice/record.js"
import { transcribeAudio } from "../../voice/stt.js"
import { runChat } from "../chat.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

function printUsage(): void {
  console.log(`${MAGENTA}momo /voice${RESET} — voice input`)
  console.log(``)
  console.log(`Usage:`)
  console.log(`  momo /voice [--seconds=5] [--lang=zh]   Record → transcribe → run as prompt`)
  console.log(`  momo /voice --file=audio.mp3            Transcribe a file → run as prompt`)
  console.log(`  momo /voice transcribe [--file=x.wav]   Print transcription only`)
  console.log(``)
  console.log(`Recording: python + sounddevice (pip install sounddevice scipy)`)
  console.log(`STT env:   MOMO_STT_API_KEY, MOMO_STT_BASE_URL (default OpenAI),`)
  console.log(`           MOMO_STT_MODEL (default whisper-1; Groq: whisper-large-v3)`)
}

export async function runVoiceCommand(args: string[]): Promise<void> {
  const transcribeOnly = args[0] === "transcribe"
  let seconds = Number(process.env.MOMO_VOICE_SECONDS || 5) || 5
  let file: string | undefined
  let language: string | undefined

  for (const a of args) {
    if (a.startsWith("--seconds=")) seconds = Number(a.slice(10)) || seconds
    else if (a.startsWith("--file=")) file = a.slice(7)
    else if (a.startsWith("--lang=")) language = a.slice(7)
    else if (a === "--help" || a === "-h") {
      printUsage()
      return
    }
  }

  // ---- 1. Obtain audio -------------------------------------------------------
  let audioPath = file
  let cleanup = false
  if (!audioPath) {
    audioPath = path.join(os.tmpdir(), `momo-voice-${Date.now()}.wav`)
    console.error(
      `${DIM}→ recording ${seconds}s from microphone… speak now${RESET}`,
    )
    try {
      const rec = await recordAudio(audioPath, seconds)
      if (rec.peak === 0) {
        console.error(
          `${YELLOW}!${RESET} recorded audio is silent — check your microphone`,
        )
      }
    } catch (err) {
      console.error(
        `${MAGENTA}✗${RESET} ${err instanceof Error ? err.message : String(err)}`,
      )
      process.exit(1)
    }
    cleanup = true
  }

  if (!fs.existsSync(audioPath)) {
    console.error(`${MAGENTA}✗${RESET} audio file not found: ${audioPath}`)
    process.exit(1)
  }

  // ---- 2. Transcribe -----------------------------------------------------------
  console.error(`${DIM}→ transcribing…${RESET}`)
  let text: string
  try {
    text = await transcribeAudio(audioPath, {
      ...(language ? { language } : {}),
    })
  } catch (err) {
    if (cleanup) fs.rmSync(audioPath, { force: true })
    console.error(
      `${MAGENTA}✗${RESET} ${err instanceof Error ? err.message : String(err)}`,
    )
    process.exit(1)
  } finally {
    if (cleanup) fs.rmSync(audioPath, { force: true })
  }

  if (!text) {
    console.error(`${YELLOW}!${RESET} transcription is empty — nothing heard`)
    process.exit(1)
  }

  console.log(`${GREEN}🎤${RESET} ${CYAN}${text}${RESET}`)
  console.error(``)

  if (transcribeOnly) return

  // ---- 3. Run as a normal prompt ------------------------------------------------
  const code = await runChat(text)
  if (code !== 0) process.exit(code)
}
