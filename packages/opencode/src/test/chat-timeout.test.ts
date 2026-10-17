import { describe, it, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { createServer, type RequestListener, type ServerResponse } from "node:http"
import { chatComplete } from "../cli/chat.js"

async function fixture(t: TestContext, handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return `http://127.0.0.1:${address.port}`
}

function later(t: TestContext, delayMs: number, callback: () => void): void {
  const timer = setTimeout(callback, delayMs)
  t.after(() => clearTimeout(timer))
}

function reply(response: ServerResponse, stream: boolean): void {
  response.end(stream
    ? 'data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n'
    : '{"choices":[{"message":{"content":"fixture"}}]}')
}

function options(baseUrl: string, stream: boolean) {
  return {
    baseUrl,
    apiKey: "offline-fixture-key",
    model: "fixture",
    messages: [{ role: "user" as const, content: "offline fixture" }],
    stream,
    timeout: 150,
  }
}

describe("chat request deadlines", () => {
  for (const stream of [false, true]) {
    it(`completes a prompt ${stream ? "SSE" : "JSON"} response`, { timeout: 4_000 }, async (t) => {
      const baseUrl = await fixture(t, (_request, response) => reply(response, stream))
      assert.equal(await chatComplete({ ...options(baseUrl, stream), timeout: 1_000 }), "fixture")
    })

    it(`times out a stalled ${stream ? "SSE" : "JSON"} body after headers arrive`, { timeout: 4_000 }, async (t) => {
      const baseUrl = await fixture(t, (_request, response) => {
        response.writeHead(200, { "Content-Type": stream ? "text/event-stream" : "application/json" })
        response.flushHeaders()
        if (stream) response.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n')
        // Finish eventually so an implementation without a body deadline fails
        // the assertion instead of leaving the test process hanging.
        later(t, 600, () => reply(response, stream))
      })
      const tokens: string[] = []
      await assert.rejects(chatComplete({
        ...options(baseUrl, stream), onToken: (chunk) => tokens.push(chunk),
      }), /Request timed out after 150ms/)
      if (stream) assert.deepEqual(tokens, ["started"])
    })
  }

  it("times out while reading an HTTP error body", { timeout: 4_000 }, async (t) => {
    const baseUrl = await fixture(t, (_request, response) => {
      response.writeHead(503)
      response.flushHeaders()
      later(t, 600, () => response.end("provider unavailable"))
    })
    await assert.rejects(chatComplete(options(baseUrl, false)), /Request timed out after 150ms/)
  })

  it("preserves a promptly returned HTTP error", { timeout: 4_000 }, async (t) => {
    const baseUrl = await fixture(t, (_request, response) => {
      response.writeHead(503)
      response.end("provider unavailable")
    })
    await assert.rejects(chatComplete({ ...options(baseUrl, false), timeout: 1_000 }), /HTTP 503: Service Unavailable \| provider unavailable/)
  })

  it("cancels the rejected stream_options body before retrying successfully", { timeout: 4_000 }, async (t) => {
    const requests: Array<{ stream_options?: unknown }> = []
    let firstClosed: () => void = () => {}
    const cancelled = new Promise<boolean>((resolve) => { firstClosed = () => resolve(true) })
    const baseUrl = await fixture(t, async (request, response) => {
      let body = ""
      for await (const chunk of request) body += chunk
      requests.push(JSON.parse(body))
      if (requests.length === 1) {
        response.on("close", firstClosed)
        response.writeHead(400)
        response.flushHeaders()
        // Leave this body open: the caller must release it before retrying.
      } else {
        reply(response, true)
      }
    })
    assert.equal(await chatComplete({ ...options(baseUrl, true), timeout: 1_000, onUsage: () => {} }), "fixture")
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[0].stream_options, { include_usage: true })
    assert.equal(requests[1].stream_options, undefined)
    const closed = await Promise.race([
      cancelled,
      new Promise<boolean>((resolve) => later(t, 250, () => resolve(false))),
    ])
    assert.equal(closed, true, "the abandoned 400 response body must be cancelled")
  })

  it("keeps the original deadline across the stream_options retry", { timeout: 4_000 }, async (t) => {
    let requests = 0
    const baseUrl = await fixture(t, (request, response) => {
      request.resume()
      requests++
      if (requests === 1) {
        later(t, 300, () => {
          response.writeHead(400)
          response.end("stream_options unsupported")
        })
      } else {
        response.writeHead(200, { "Content-Type": "text/event-stream" })
        response.flushHeaders()
        // This arrives after the original 600 ms deadline, but before a
        // wrongly reset deadline of 600 ms from the second request.
        later(t, 450, () => reply(response, true))
      }
    })
    await assert.rejects(chatComplete({
      ...options(baseUrl, true), timeout: 600, onUsage: () => {},
    }), /Request timed out after 600ms/)
    assert.equal(requests, 2)
  })
})
