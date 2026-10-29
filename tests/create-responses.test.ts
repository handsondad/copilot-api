import { afterEach, expect, test } from "bun:test"

import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

const originalFetch = globalThis.fetch
const originalCopilotToken = state.copilotToken
let forwardedPayload: Record<string, unknown> | undefined

afterEach(() => {
  globalThis.fetch = originalFetch
  state.copilotToken = originalCopilotToken
  forwardedPayload = undefined
})

test("omits unsupported service_tier while preserving other Responses fields", async () => {
  state.copilotToken = "test-token"
  const fetchMock = Object.assign(
    (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected a string request body")
      }

      forwardedPayload = JSON.parse(init.body) as Record<string, unknown>
      return Promise.resolve(new Response(null, { status: 200 }))
    },
    { preconnect: originalFetch.preconnect },
  )
  globalThis.fetch = fetchMock

  const payload: ResponsesPayload = {
    model: "gpt-6-luna",
    input: "Reply with exactly OK.",
    service_tier: "priority",
    reasoning: { effort: "medium" },
  }

  await createResponses(payload)

  expect(forwardedPayload).not.toHaveProperty("service_tier")
  expect(forwardedPayload).toMatchObject({
    model: "gpt-6-luna",
    input: "Reply with exactly OK.",
    reasoning: { effort: "medium" },
  })
  expect(payload.service_tier).toBe("priority")
})
