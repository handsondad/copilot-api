import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import { createResponses } from "./create-responses"
import {
  toChatCompletionResponse,
  toChatCompletionStream,
  toResponsesPayload,
} from "./responses-compat"

const responsesOnlyModels = new Set<string>()

const createChatCompletionViaResponses = async (
  payload: ChatCompletionsPayload,
) => {
  const response = await createResponses(toResponsesPayload(payload))
  if (payload.stream) {
    return toChatCompletionStream(events(response), payload.model)
  }

  const completion = toChatCompletionResponse(
    await response.json(),
    payload.model,
  )

  return completion
}

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  if (responsesOnlyModels.has(payload.model)) {
    return createChatCompletionViaResponses(payload)
  }

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const request = (requestPayload: ChatCompletionsPayload) =>
    fetch(`${copilotBaseUrl(state)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestPayload),
    })

  let response = await request(payload)

  if (!response.ok) {
    let errorBody = await response.clone().text()
    const lastMessage = payload.messages.at(-1)
    if (
      errorBody.includes("assistant message prefill")
      && lastMessage?.role === "assistant"
      && typeof lastMessage.content === "string"
      && !lastMessage.tool_calls?.length
    ) {
      consola.info(
        `Model ${payload.model} rejected assistant prefill; retrying with a continuation user message`,
      )
      response = await request({
        ...payload,
        messages: [
          ...payload.messages,
          {
            role: "user",
            content: "Continue the assistant response above.",
          },
        ],
      })
      if (!response.ok) {
        errorBody = await response.clone().text()
      }
    }

    if (!response.ok && errorBody.includes("unsupported_api_for_model")) {
      responsesOnlyModels.add(payload.model)
      consola.info(
        `Model ${payload.model} requires the Responses API; retrying with it`,
      )
      return createChatCompletionViaResponses(payload)
    }

    if (!response.ok) {
      consola.error("Failed to create chat completions", response)
      throw new HTTPError("Failed to create chat completions", response)
    }
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
