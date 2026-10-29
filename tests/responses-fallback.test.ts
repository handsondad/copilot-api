import { afterEach, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { state } from "~/lib/state"

import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const requests: Array<{ url: string; body: Record<string, unknown> }> = []

const isAsyncEventStream = (
  value: unknown,
): value is AsyncIterable<{ data?: string }> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value

const responsesResult = {
  id: "resp_test",
  created_at: 1_790_000_000,
  model: "gpt-6-luna",
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: "OK" }],
    },
  ],
  usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
}

const responsesStream = [
  {
    type: "response.created",
    response: {
      id: "resp_test",
      created_at: 1_790_000_000,
      model: "gpt-6-luna",
    },
  },
  { type: "response.output_text.delta", delta: "OK" },
  {
    type: "response.completed",
    response: {
      status: "completed",
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    },
  },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("")

const mockFetch = () => {
  const fetchMock = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a string request body")
      }
      const body = JSON.parse(init.body) as Record<string, unknown>
      requests.push({ url, body })

      if (url.endsWith("/chat/completions")) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                message: JSON.stringify({
                  error: { code: "unsupported_api_for_model" },
                }),
              },
            },
            { status: 400 },
          ),
        )
      }

      if (body.stream === true) {
        return Promise.resolve(
          new Response(responsesStream, {
            headers: { "content-type": "text/event-stream" },
          }),
        )
      }

      return Promise.resolve(Response.json(responsesResult))
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = fetchMock
}

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = originalCopilotToken
  requests.length = 0
})

const payload: ChatCompletionsPayload = {
  model: "gpt-6-luna",
  messages: [{ role: "user", content: "Reply with exactly OK." }],
  max_completion_tokens: 32,
}

test("retries models on the Responses API and translates the response", async () => {
  state.copilotToken = "test-token"
  mockFetch()

  const result = await createChatCompletions(payload)

  expect(requests.map((request) => request.url.split("/").pop())).toEqual([
    "completions",
    "responses",
  ])
  expect(requests[1].body.max_output_tokens).toBe(32)
  expect(requests[1].body).not.toHaveProperty("max_tokens")
  expect(result).toMatchObject({
    object: "chat.completion",
    model: "gpt-6-luna",
    choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
  })
})

test("returns a Chat Completions stream when a fallback response is requested", async () => {
  state.copilotToken = "test-token"
  mockFetch()

  const result = await createChatCompletions({
    ...payload,
    stream: true,
  })

  if (!isAsyncEventStream(result)) {
    throw new Error("Expected a streaming response")
  }

  const chunks: Array<string> = []
  for await (const event of result) {
    if (event.data) chunks.push(event.data)
  }

  expect(chunks.some((chunk) => chunk.includes('"content":"OK"'))).toBe(true)
  expect(chunks.at(-1)).toBe("[DONE]")
})

test("retries assistant prefill requests with a continuation user message", async () => {
  state.copilotToken = "test-token"
  const fetchMock = Object.assign(
    (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a string request body")
      }
      const body = JSON.parse(init.body) as Record<string, unknown>
      requests.push({ url, body })

      if (requests.length === 1) {
        return Promise.resolve(
          Response.json(
            {
              error: {
                message:
                  "This model does not support assistant message prefill. The conversation must end with a user message.",
              },
            },
            { status: 400 },
          ),
        )
      }

      return Promise.resolve(
        Response.json({
          id: "chatcmpl_test",
          object: "chat.completion",
          created: 1,
          model: "claude-sonnet-5.5",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "42" },
              finish_reason: "stop",
            },
          ],
        }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = fetchMock

  const result = await createChatCompletions({
    model: "claude-sonnet-5.5",
    messages: [
      { role: "user", content: "What is 6 times 7?" },
      { role: "assistant", content: "The answer is" },
    ],
  })

  expect(requests).toHaveLength(2)
  expect(requests[1].body.messages).toEqual([
    { role: "user", content: "What is 6 times 7?" },
    { role: "assistant", content: "The answer is" },
    { role: "user", content: "Continue the assistant response above." },
  ])
  expect(result).toMatchObject({
    choices: [{ message: { content: "42" } }],
  })
})
