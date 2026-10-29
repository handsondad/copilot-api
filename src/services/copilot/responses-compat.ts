import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ToolCall,
} from "./create-chat-completions"

export interface ResponsesRequestPayload {
  model: string
  input: Array<unknown>
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stream: boolean
  tools?: Array<{
    type: "function"
    name: string
    description?: string
    parameters: Record<string, unknown>
  }>
  tool_choice?: unknown
  text?: {
    format: { type: "json_object" }
  }
  [key: string]: unknown
}

const toResponseContent = (
  content: string | Array<ContentPart> | null,
): string | Array<Record<string, unknown>> => {
  if (typeof content === "string") return content
  if (content === null) return ""

  return content.map((part) => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text }
    }

    return {
      type: "input_image",
      image_url: part.image_url.url,
      detail: part.image_url.detail,
    }
  })
}

const toResponseInput = (message: Message): Array<unknown> => {
  if (message.role === "tool") {
    return [
      {
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : "",
      },
    ]
  }

  const items: Array<unknown> = []
  if (message.content !== null || !message.tool_calls?.length) {
    items.push({
      role: message.role,
      content: toResponseContent(message.content),
    })
  }

  for (const call of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })
  }

  return items
}

const toResponseToolChoice = (
  toolChoice: ChatCompletionsPayload["tool_choice"],
): unknown => {
  if (typeof toolChoice !== "object" || toolChoice === null) {
    return toolChoice === "required" ? "required" : toolChoice
  }

  return {
    type: "function",
    name: toolChoice.function.name,
  }
}

export const toResponsesPayload = (
  payload: ChatCompletionsPayload,
): ResponsesRequestPayload => {
  const maxOutputTokens =
    payload.max_completion_tokens ?? payload.max_tokens ?? undefined

  return {
    model: payload.model,
    input: payload.messages.flatMap((message) => toResponseInput(message)),
    ...(maxOutputTokens === undefined ?
      {}
    : { max_output_tokens: maxOutputTokens }),
    ...(payload.temperature === undefined ?
      {}
    : { temperature: payload.temperature }),
    ...(payload.top_p === undefined ? {} : { top_p: payload.top_p }),
    stream: Boolean(payload.stream),
    ...(payload.tools ?
      {
        tools: payload.tools.map((tool) => ({
          type: "function" as const,
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        })),
      }
    : {}),
    ...(payload.tool_choice === undefined ?
      {}
    : { tool_choice: toResponseToolChoice(payload.tool_choice) }),
    ...(payload.response_format?.type === "json_object" ?
      { text: { format: { type: "json_object" as const } } }
    : {}),
  }
}

interface ResponsesResult {
  id?: string
  created_at?: number
  model?: string
  output?: Array<unknown>
  output_text?: string | null
  status?: string
  incomplete_details?: { reason?: string } | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ?
    (value as Record<string, unknown>)
  : undefined

const toToolCall = (value: unknown): ToolCall | undefined => {
  const item = asRecord(value)
  if (
    item?.type !== "function_call"
    || typeof item.call_id !== "string"
    || typeof item.name !== "string"
    || typeof item.arguments !== "string"
  ) {
    return undefined
  }

  return {
    id: item.call_id,
    type: "function",
    function: { name: item.name, arguments: item.arguments },
  }
}

const getMessageText = (value: unknown): Array<string> => {
  const item = asRecord(value)
  if (item?.type !== "message" || !Array.isArray(item.content)) return []

  return item.content.flatMap((content) => {
    const block = asRecord(content)
    if (block?.type === "output_text" && typeof block.text === "string") {
      return [block.text]
    }
    if (block?.type === "refusal" && typeof block.refusal === "string") {
      return [block.refusal]
    }
    return []
  })
}

const getFinishReason = (
  response: ResponsesResult,
  toolCalls: Array<ToolCall>,
): "stop" | "length" | "tool_calls" | "content_filter" => {
  if (toolCalls.length > 0) return "tool_calls"
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ?
        "content_filter"
      : "length"
  }
  return "stop"
}

export const toChatCompletionResponse = (
  value: unknown,
  fallbackModel: string,
): ChatCompletionResponse => {
  const response = (asRecord(value) ?? {}) as ResponsesResult
  const output = response.output ?? []
  const toolCalls = output.flatMap((item) => {
    const toolCall = toToolCall(item)
    return toolCall ? [toolCall] : []
  })
  const text = output.flatMap((item) => getMessageText(item)).join("")
  const content = text || response.output_text || null

  return {
    id: response.id ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model: response.model ?? fallbackModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: getFinishReason(response, toolCalls),
      },
    ],
    ...(response.usage ?
      {
        usage: {
          prompt_tokens: response.usage.input_tokens ?? 0,
          completion_tokens: response.usage.output_tokens ?? 0,
          total_tokens: response.usage.total_tokens ?? 0,
        },
      }
    : {}),
  }
}

interface ChatStreamState {
  id: string
  created: number
  model: string
  roleSent: boolean
  sawToolCall: boolean
  nextToolCallIndex: number
  toolCallIndices: Map<number, number>
}

const makeStreamChunk = (
  state: ChatStreamState,
  choices: Array<unknown>,
  usage?: Record<string, number>,
) => ({
  data: JSON.stringify({
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices,
    ...(usage ? { usage } : {}),
  }),
})

const makeRoleChunk = (state: ChatStreamState) =>
  makeStreamChunk(state, [
    {
      index: 0,
      delta: { role: "assistant" },
      finish_reason: null,
      logprobs: null,
    },
  ])

const updateStreamMetadata = (
  event: Record<string, unknown>,
  state: ChatStreamState,
) => {
  const response = asRecord(event.response)
  if (!response) return
  if (typeof response.id === "string") state.id = response.id
  if (typeof response.created_at === "number") {
    state.created = response.created_at
  }
  if (typeof response.model === "string") state.model = response.model
}

const makeToolCallStartChunk = (
  event: Record<string, unknown>,
  state: ChatStreamState,
) => {
  const item = asRecord(event.item)
  if (
    item?.type !== "function_call"
    || typeof event.output_index !== "number"
    || typeof item.call_id !== "string"
    || typeof item.name !== "string"
  ) {
    return undefined
  }

  const index = state.nextToolCallIndex++
  state.toolCallIndices.set(event.output_index, index)
  state.sawToolCall = true

  return makeStreamChunk(state, [
    {
      index: 0,
      delta: {
        tool_calls: [
          {
            index,
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: "" },
          },
        ],
      },
      finish_reason: null,
      logprobs: null,
    },
  ])
}

const makeToolCallArgumentsChunk = (
  event: Record<string, unknown>,
  state: ChatStreamState,
) => {
  if (
    typeof event.output_index !== "number"
    || typeof event.delta !== "string"
  ) {
    return undefined
  }

  const index = state.toolCallIndices.get(event.output_index)
  if (index === undefined) return undefined

  return makeStreamChunk(state, [
    {
      index: 0,
      delta: {
        tool_calls: [{ index, function: { arguments: event.delta } }],
      },
      finish_reason: null,
      logprobs: null,
    },
  ])
}

const makeTerminalChunk = (
  eventType: string,
  event: Record<string, unknown>,
  state: ChatStreamState,
) => {
  const response = asRecord(event.response)
  const usage = asRecord(response?.usage)
  const incompleteDetails = asRecord(response?.incomplete_details)
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"
  if (state.sawToolCall) finishReason = "tool_calls"
  else if (eventType === "response.incomplete") {
    finishReason =
      incompleteDetails?.reason === "content_filter" ?
        "content_filter"
      : "length"
  }

  return makeStreamChunk(
    state,
    [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage ?
      {
        prompt_tokens:
          typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
        completion_tokens:
          typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        total_tokens:
          typeof usage.total_tokens === "number" ? usage.total_tokens : 0,
      }
    : undefined,
  )
}

const getStreamErrorMessage = (event: Record<string, unknown>) => {
  const response = asRecord(event.response)
  const error = asRecord(event.error) ?? asRecord(response?.error)
  return typeof error?.message === "string" ?
      error.message
    : "Responses API request failed"
}

type ChatStreamEvent = { data: string }

const addRoleChunk = (
  state: ChatStreamState,
  chunks: Array<ChatStreamEvent>,
) => {
  if (!state.roleSent) {
    state.roleSent = true
    chunks.push(makeRoleChunk(state))
  }
}

const makeOutputTextChunks = (
  event: Record<string, unknown>,
  state: ChatStreamState,
): Array<ChatStreamEvent> => {
  const chunks: Array<ChatStreamEvent> = []
  addRoleChunk(state, chunks)
  if (typeof event.delta === "string") {
    chunks.push(
      makeStreamChunk(state, [
        {
          index: 0,
          delta: { content: event.delta },
          finish_reason: null,
          logprobs: null,
        },
      ]),
    )
  }
  return chunks
}

const makeOutputItemChunks = (
  event: Record<string, unknown>,
  state: ChatStreamState,
): Array<ChatStreamEvent> => {
  const toolChunk = makeToolCallStartChunk(event, state)
  if (!toolChunk) return []

  const chunks: Array<ChatStreamEvent> = []
  addRoleChunk(state, chunks)
  chunks.push(toolChunk)
  return chunks
}

const makeTerminalChunks = (
  event: Record<string, unknown>,
  state: ChatStreamState,
): Array<ChatStreamEvent> => {
  const chunks: Array<ChatStreamEvent> = []
  addRoleChunk(state, chunks)
  chunks.push(makeTerminalChunk(String(event.type), event, state), {
    data: "[DONE]",
  })
  return chunks
}

export async function* toChatCompletionStream(
  responseEvents: AsyncIterable<{ data?: string }>,
  fallbackModel: string,
): AsyncGenerator<ChatStreamEvent> {
  const state: ChatStreamState = {
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: fallbackModel,
    roleSent: false,
    sawToolCall: false,
    nextToolCallIndex: 0,
    toolCallIndices: new Map(),
  }

  for await (const responseEvent of responseEvents) {
    if (!responseEvent.data || responseEvent.data === "[DONE]") continue

    const event = asRecord(JSON.parse(responseEvent.data))
    if (!event) throw new Error("Invalid Responses API stream event")
    updateStreamMetadata(event, state)

    switch (event.type) {
      case "response.created": {
        if (!state.roleSent) {
          state.roleSent = true
          yield makeRoleChunk(state)
        }
        break
      }
      case "response.output_text.delta": {
        yield* makeOutputTextChunks(event, state)
        break
      }
      case "response.output_item.added": {
        yield* makeOutputItemChunks(event, state)
        break
      }
      case "response.function_call_arguments.delta": {
        const argumentsChunk = makeToolCallArgumentsChunk(event, state)
        if (argumentsChunk) yield argumentsChunk
        break
      }
      case "response.completed":
      case "response.incomplete": {
        yield* makeTerminalChunks(event, state)
        return
      }
      case "response.failed":
      case "error": {
        throw new Error(getStreamErrorMessage(event))
      }
      // No default
    }
  }

  throw new Error("Responses API stream ended before completion")
}
