import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getModelVersion, getOrCreateModel, shouldUseResponsesApi } from "~/lib/model"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createResponsesStreamState,
  translateChatToResponsesRequest,
  translateResponsesEventToChatChunk,
  translateResponsesToChatResponse,
} from "~/routes/responses/translation"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"
import { createResponse } from "~/services/copilot/create-response"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()

  // Find the selected model
  const selectedModel = getOrCreateModel(payload.model)

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug("Set max_tokens to:", JSON.stringify(payload.max_tokens))
  }

  // Route to createResponse for models >= 5.4 or explicitly "gpt-5.4"
  // This allows clients using the standard /chat/completions endpoint to transparently use the new backend
  const version = getModelVersion(payload.model)

  consola.info(`Model: ${payload.model}, Version: ${version}`)

  let response
  const useResponsesApi = shouldUseResponsesApi(payload.model)

  if (useResponsesApi) {
    consola.info(`Routing model ${payload.model} (>= 5.4) to Responses API (/v1/responses)`)
    response = await createResponse(translateChatToResponsesRequest(payload))
  } else {
    consola.info(`Routing model ${payload.model} (< 5.4) to Chat Completions API`)
    response = await createChatCompletions(payload)
  }

  if (useResponsesApi && !isStreamingResponse(response)) {
    const chatResponse = translateResponsesToChatResponse(response)
    return c.json(chatResponse)
  }

  if (!useResponsesApi && isNonStreaming(response)) {
    return c.json(response)
  }

  consola.debug("Streaming response")
  return streamSSE(c, async (stream) => {
    const responsesStreamState = createResponsesStreamState(payload.model)
    let sentDone = false

    for await (const chunk of response) {
      if (useResponsesApi) {
        if (chunk.data === "[DONE]") {
          await stream.writeSSE({ data: "[DONE]" })
          sentDone = true
          break
        }

        if (!chunk.data) {
          continue
        }

        const translatedChunk = translateResponsesEventToChatChunk(
          chunk.data,
          responsesStreamState,
        )

        if (translatedChunk) {
          await stream.writeSSE({ data: JSON.stringify(translatedChunk) })
        }

        continue
      }

      await stream.writeSSE(chunk as SSEMessage)
    }

    if (useResponsesApi && !sentDone) {
      await stream.writeSSE({ data: "[DONE]" })
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>> | Awaited<ReturnType<typeof createResponse>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isStreamingResponse = (
  response: Awaited<ReturnType<typeof createResponse>> | Awaited<ReturnType<typeof createChatCompletions>>,
): response is AsyncIterable<{ data?: string }> => !Object.hasOwn(response, "choices") && !Object.hasOwn(response, "object")

