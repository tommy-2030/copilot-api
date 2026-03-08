import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import type {
  ResponsesApiRequest,
  ResponsesApiResponse,
} from "~/routes/responses/types"

export type ResponsesStream = AsyncIterable<{ data?: string }>

export const createResponse = async (
  payload: ResponsesApiRequest,
): Promise<ResponsesApiResponse | ResponsesStream> => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = typeof payload.input !== "string" && payload.input.some(
    (item) =>
      Array.isArray(item.content)
      && item.content.some((part) => part.type === "input_image"),
  )

  // Agent/user check for X-Initiator header
  const isAgentCall = typeof payload.input !== "string"
    && payload.input.some((item) => item.role === "assistant")

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  consola.debug("Sending request to /v1/responses")

  // Use /v1/responses endpoint as requested
  // Note: standard Copilot endpoints are usually versionless at the root (e.g. /chat/completions),
  // but we are explicitly appending /v1/responses here to match the specific requirement for newer models.
  const response = await fetch(`${copilotBaseUrl(state)}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.clone().text()
    consola.error(
      `Failed to create response. Status: ${response.status} ${response.statusText}`,
    )

    throw new HTTPError(`Failed to create response: ${errorText}`, response)
  }

  if (payload.stream) {
    return events(response) as ResponsesStream
  }

  return (await response.json()) as ResponsesApiResponse
}
