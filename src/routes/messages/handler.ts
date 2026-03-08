import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { getModelVersion, shouldUseResponsesApi } from "~/lib/model"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createResponsesStreamState,
  translateChatToResponsesRequest,
  translateResponsesEventToChatChunk,
  translateResponsesToChatResponse,
} from "~/routes/responses/translation"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"
import { createResponse } from "~/services/copilot/create-response"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

  const openAIPayload = translateToOpenAI(anthropicPayload)

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Route to createResponse for models >= 5.4 or explicitly "gpt-5.4"
  const version = getModelVersion(openAIPayload.model)
  const useResponsesApi = shouldUseResponsesApi(openAIPayload.model)

  consola.info(`Anthropic Model Translated: ${openAIPayload.model}, Version: ${version}`)

  let response
  if (useResponsesApi) {
    consola.info(`Routing Anthropic model ${openAIPayload.model} (>= 5.4) to Responses API (/v1/responses)`)
    response = await createResponse(translateChatToResponsesRequest(openAIPayload))
  } else {
    consola.info(`Routing Anthropic model ${openAIPayload.model} (< 5.4) to Chat Completions API`)
    response = await createChatCompletions(openAIPayload)
  }

  if (useResponsesApi && !isStreamingResponse(response)) {
    const anthropicResponse = translateToAnthropic(
      translateResponsesToChatResponse(response),
    )
    return c.json(anthropicResponse)
  }

  if (isNonStreaming(response)) {
    const anthropicResponse = translateToAnthropic(response)
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }
    const responsesStreamState = createResponsesStreamState(openAIPayload.model)

    for await (const rawEvent of response) {
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk =
        useResponsesApi ?
          translateResponsesEventToChatChunk(rawEvent.data, responsesStreamState)
        : (JSON.parse(rawEvent.data) as ChatCompletionChunk)

      if (!chunk) {
        continue
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>> | Awaited<ReturnType<typeof createResponse>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")

const isStreamingResponse = (
  response: Awaited<ReturnType<typeof createResponse>> | Awaited<ReturnType<typeof createChatCompletions>>,
): response is AsyncIterable<{ data?: string }> => !Object.hasOwn(response, "choices") && !Object.hasOwn(response, "object")
