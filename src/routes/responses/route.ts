import { Hono } from "hono"

import { awaitApproval } from "~/lib/approval"
import { forwardError } from "~/lib/error"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"

export const responsesRoute = new Hono()

responsesRoute.post("/", async (c) => {
  try {
    await checkRateLimit(state)
    const payload = await c.req.json<ResponsesPayload>()

    if (state.manualApprove) await awaitApproval()

    return await createResponses(payload)
  } catch (error) {
    return await forwardError(c, error)
  }
})
