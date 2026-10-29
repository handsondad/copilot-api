import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ResponsesPayload {
  model: string
  input?: unknown
  [key: string]: unknown
}

const containsInputImage = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => containsInputImage(item))
  }

  if (typeof value !== "object" || value === null) {
    return false
  }

  return Object.entries(value).some(
    ([key, nestedValue]) =>
      (key === "type" && nestedValue === "input_image")
      || containsInputImage(nestedValue),
  )
}

const isAgentInput = (input: unknown): boolean => {
  if (!Array.isArray(input)) {
    return false
  }

  return input.some((item) => {
    if (typeof item !== "object" || item === null) {
      return false
    }

    const entry = item as Record<string, unknown>
    return (
      entry.role === "assistant"
      || entry.role === "tool"
      || entry.type === "function_call"
      || entry.type === "function_call_output"
    )
  })
}

export const createResponses = async (
  payload: ResponsesPayload,
): Promise<Response> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const upstreamPayload = { ...payload }
  delete upstreamPayload.service_tier

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers: {
      ...copilotHeaders(state, containsInputImage(payload.input)),
      "X-Initiator": isAgentInput(payload.input) ? "agent" : "user",
    },
    body: JSON.stringify(upstreamPayload),
  })

  if (!response.ok) throw new HTTPError("Failed to create responses", response)

  return response
}
