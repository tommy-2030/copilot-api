import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getOrCreateModel } from "~/lib/model"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  normalizeResponsesRequest,
  translateResponsesToChatPayload,
} from "~/routes/responses/translation"
import {
  createResponse,
} from "~/services/copilot/create-response"
import type { ResponsesApiRequest } from "./types"

export async function handleResponse(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ResponsesApiRequest>()

  const selectedModel = getOrCreateModel(payload.model)

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenPayload = translateResponsesToChatPayload(payload)
      const tokenCount = await getTokenCount(tokenPayload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_output_tokens)) {
    payload = {
      ...payload,
      max_output_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_output_tokens to:", JSON.stringify(payload.max_output_tokens))
  }

  const response = await createResponse(normalizeResponsesRequest(payload))

  if (isNonStreaming(response)) {
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createResponse>>,
): response is Exclude<Awaited<ReturnType<typeof createResponse>>, AsyncIterable<unknown>> => Object.hasOwn(response, "object")
