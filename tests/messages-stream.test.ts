import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import { state } from "~/lib/state"
import { messageRoutes } from "~/routes/messages/route"

const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalManualApprove = state.manualApprove
const originalRateLimitSeconds = state.rateLimitSeconds
const app = new Hono().route("/v1/messages", messageRoutes)

const streamResponse = (includeFinishReason: boolean) => {
  const chunks = [
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude-sonnet-5.5",
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
          logprobs: null,
        },
      ],
    },
    {
      id: "chatcmpl_test",
      object: "chat.completion.chunk",
      created: 1,
      model: "claude-sonnet-5.5",
      choices: [
        {
          index: 0,
          delta: { content: "Hello" },
          finish_reason: includeFinishReason ? "stop" : null,
          logprobs: null,
        },
      ],
    },
  ]
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")

  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })
}

const mockFetch = (response: Response) => {
  const fetchMock = Object.assign(
    (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => Promise.resolve(response),
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = fetchMock
}

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = originalCopilotToken
  state.manualApprove = originalManualApprove
  state.rateLimitSeconds = originalRateLimitSeconds
})

const request = () =>
  app.request("/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5.5",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "Say hello." }],
    }),
  })

test("reports an error when the upstream stream ends before message_stop", async () => {
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  mockFetch(streamResponse(false))

  const response = await request()
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain("event: error")
  expect(body).toContain(
    '"message":"An unexpected error occurred during streaming."',
  )
  expect(body).not.toContain("event: message_stop")
})

test("preserves successful message_stop events for complete streams", async () => {
  state.copilotToken = "test-token"
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  mockFetch(streamResponse(true))

  const response = await request()
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(body).toContain("event: message_stop")
  expect(body).not.toContain("event: error")
})

test(
  "sends ping events while waiting for the upstream stream",
  async () => {
    state.copilotToken = "test-token"
    state.manualApprove = false
    state.rateLimitSeconds = undefined
    const fetchMock = Object.assign(
      async (
        _input: Parameters<typeof fetch>[0],
        _init?: Parameters<typeof fetch>[1],
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 6_500))
        return streamResponse(true)
      },
      { preconnect: originalFetch.preconnect },
    )
    globalThis.fetch = fetchMock

    const response = await request()
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Expected a streaming response body")

    const decoder = new TextDecoder()
    const firstChunk = await reader.read()
    expect(firstChunk.done).toBe(false)
    if (!(firstChunk.value instanceof Uint8Array)) {
      throw new TypeError("Expected a byte chunk")
    }
    const firstText = decoder.decode(firstChunk.value)
    expect(firstText).toContain("event: ping")

    let body = firstText
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!(chunk.value instanceof Uint8Array)) {
        throw new TypeError("Expected a byte chunk")
      }
      body += decoder.decode(chunk.value)
    }

    expect(body).toContain("event: message_start")
    expect(body).toContain("event: message_stop")
  },
  { timeout: 15_000 },
)
