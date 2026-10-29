import { afterEach, expect, test } from "bun:test"
import { Hono } from "hono"

import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"

import { completionRoutes } from "../src/routes/chat-completions/route"

const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
const originalModels = state.models
let forwardedPayload: Record<string, unknown> | undefined

const app = new Hono().route("/v1/chat/completions", completionRoutes)
const model: Model = {
  capabilities: {
    family: "test",
    limits: { max_output_tokens: 4096 },
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "test-model",
  model_picker_enabled: true,
  name: "Test model",
  object: "model",
  preview: false,
  vendor: "test",
  version: "1",
}

const mockCompletionFetch = () => {
  const fetchMock = Object.assign(
    (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a string request body")
      }
      forwardedPayload = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(
        Response.json({
          id: "test-completion",
          object: "chat.completion",
          choices: [],
        }),
      )
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = fetchMock
}

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = originalCopilotToken
  state.models = originalModels
  forwardedPayload = undefined
})

test("does not add max_tokens when max_completion_tokens is provided", async () => {
  state.copilotToken = "test-token"
  state.models = { data: [model], object: "list" }
  mockCompletionFetch()

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: "Hello" }],
      max_completion_tokens: 128,
    }),
  })

  expect(response.status).toBe(200)
  expect(forwardedPayload?.max_completion_tokens).toBe(128)
  expect(forwardedPayload).not.toHaveProperty("max_tokens")
})

test("adds the model output limit when neither token limit is provided", async () => {
  state.copilotToken = "test-token"
  state.models = { data: [model], object: "list" }
  mockCompletionFetch()

  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: "Hello" }],
    }),
  })

  expect(response.status).toBe(200)
  expect(forwardedPayload?.max_tokens).toBe(4096)
})
