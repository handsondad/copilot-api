import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEStreamingApi } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from "./stream-translation"

const STREAM_PING_INTERVAL_MS = 5_000

const raceWithStreamPing = async <T>(
  pending: Promise<T>,
): Promise<{ type: "ping" } | { type: "result"; result: T }> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const ping = new Promise<{ type: "ping" }>((resolve) => {
    timeout = setTimeout(
      () => resolve({ type: "ping" }),
      STREAM_PING_INTERVAL_MS,
    )
  })

  try {
    return await Promise.race([
      pending.then((result) => ({ type: "result" as const, result })),
      ping,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

const writePing = async (stream: SSEStreamingApi) =>
  stream.writeSSE({
    event: "ping",
    data: JSON.stringify({ type: "ping" }),
  })

const waitForWithStreamPings = async <T>(
  pending: Promise<T>,
  stream: SSEStreamingApi,
): Promise<T> => {
  while (true) {
    const result = await raceWithStreamPing(pending)
    if (result.type === "result") return result.result
    await writePing(stream)
  }
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  if (openAIPayload.stream) {
    return streamSSE(c, (stream) =>
      streamAnthropicResponse(stream, createChatCompletions(openAIPayload)),
    )
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, (stream) =>
    streamAnthropicResponse(stream, Promise.resolve(response)),
  )
}

const streamAnthropicResponse = async (
  stream: SSEStreamingApi,
  responsePromise: ReturnType<typeof createChatCompletions>,
) => {
  const streamState: AnthropicStreamState = {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    toolCalls: {},
  }
  let messageStopSent = false

  try {
    const response = await waitForWithStreamPings(responsePromise, stream)
    if (isNonStreaming(response)) {
      throw new Error("Expected a streaming response from Copilot")
    }

    const iterator = response[Symbol.asyncIterator]()
    while (true) {
      const next = await waitForWithStreamPings(iterator.next(), stream)
      if (next.done) break

      const rawEvent = next.value
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") break
      if (!rawEvent.data) continue

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
        if (event.type === "message_stop") {
          messageStopSent = true
        }
      }
    }
  } catch (error) {
    consola.error(
      "Failed to process Copilot stream:",
      error instanceof Error ? error.message : String(error),
    )
    await writeStreamingError(stream)
    return
  }

  if (!messageStopSent) {
    consola.error("Copilot stream ended before message_stop")
    await writeStreamingError(stream)
  }
}

const writeStreamingError = async (stream: SSEStreamingApi) => {
  const event = translateErrorToAnthropicErrorEvent()
  await stream.writeSSE({
    event: event.type,
    data: JSON.stringify(event),
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
