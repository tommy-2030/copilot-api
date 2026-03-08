import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import type {
  ResponsesApiRequest,
  ResponsesApiResponse,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesStreamEvent,
  ResponsesTool,
} from "./types"

interface ResponsesStreamState {
  id: string
  model: string
  created: number
  toolCallMap: Map<number, number>
  nextToolCallIndex: number
  hasToolCalls: boolean
}

export function translateChatToResponsesRequest(
  payload: ChatCompletionsPayload,
): ResponsesApiRequest {
  const instructions = payload.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => stringifyMessageContent(message.content))
    .filter(Boolean)
    .join("\n\n")

  const input = payload.messages
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map((message) => translateChatMessageToResponsesInput(message))
    .join("\n\n")

  const request: ResponsesApiRequest = {
    model: payload.model,
    input,
    max_output_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stream: payload.stream,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    parallel_tool_calls: true,
  }

  if (instructions) {
    request.instructions = instructions
  }

  if (payload.response_format?.type === "json_schema") {
    request.text = {
      format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          schema: payload.response_format.json_schema,
        },
      },
    }
  } else if (payload.response_format?.type === "json_object") {
    request.text = { format: { type: "json_object" } }
  }

  return request
}

export function normalizeResponsesRequest(
  request: ResponsesApiRequest,
): ResponsesApiRequest {
  if (typeof request.input === "string") {
    return request
  }

  return {
    ...request,
    instructions:
      request.instructions
      ?? (
        request.input
          .filter((item) => item.role === "system" || item.role === "developer")
          .map((item) => stringifyResponsesInputItem(item))
          .filter(Boolean)
          .join("\n\n")
        || undefined
      ),
    input: request.input
      .filter((item) => item.role !== "system" && item.role !== "developer")
      .map((item) => stringifyResponsesInputItem(item))
      .filter(Boolean)
      .join("\n\n"),
  }
}

export function translateResponsesToChatPayload(
  request: ResponsesApiRequest,
): ChatCompletionsPayload {
  const normalizedRequest = normalizeResponsesRequest(request)
  const input =
    typeof normalizedRequest.input === "string" ? normalizedRequest.input : ""

  return {
    model: normalizedRequest.model,
    messages: [
      ...(normalizedRequest.instructions ? [{ role: "system" as const, content: normalizedRequest.instructions }] : []),
      {
        role: "user",
        content: input,
      },
    ],
    max_tokens: normalizedRequest.max_output_tokens,
    temperature: normalizedRequest.temperature,
    top_p: normalizedRequest.top_p,
    stream: normalizedRequest.stream,
    tools: translateResponsesToolsToChat(normalizedRequest.tools),
    tool_choice: translateResponsesToolChoiceToChat(normalizedRequest.tool_choice),
  }
}

export function translateResponsesToChatResponse(
  response: ResponsesApiResponse,
): ChatCompletionResponse {
  const textSegments: Array<string> = []
  const toolCalls: NonNullable<
    ChatCompletionResponse["choices"][number]["message"]["tool_calls"]
  > = []

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const content of item.content ?? []) {
        if (content.type === "output_text" && content.text) {
          textSegments.push(content.text)
        }
      }
    }

    if (item.type === "function_call" && item.name) {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments ?? "",
        },
      })
    }
  }

  const content =
    textSegments.join("") || response.output_text || (toolCalls.length > 0 ? null : "")

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage:
      response.usage ? {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.total_tokens,
      } : undefined,
  }
}

export function createResponsesStreamState(
  model: string,
): ResponsesStreamState {
  return {
    id: `resp_${Date.now()}`,
    model,
    created: Math.floor(Date.now() / 1000),
    toolCallMap: new Map(),
    nextToolCallIndex: 0,
    hasToolCalls: false,
  }
}

export function translateResponsesEventToChatChunk(
  rawEventData: string,
  state: ResponsesStreamState,
): ChatCompletionChunk | null {
  const event = JSON.parse(rawEventData) as ResponsesStreamEvent

  if (event.type === "response.created") {
    state.id = event.response?.id ?? state.id
    state.model = event.response?.model ?? state.model
    state.created = event.response?.created_at ?? state.created
    return null
  }

  if (event.type === "response.output_text.delta") {
    return createChunk(state, {
      content: event.delta ?? "",
    })
  }

  if (event.type === "response.function_call_arguments.start" && event.item?.name) {
    const outputIndex = event.output_index ?? state.nextToolCallIndex
    const toolCallIndex = state.nextToolCallIndex++

    state.toolCallMap.set(outputIndex, toolCallIndex)
    state.hasToolCalls = true

    return createChunk(state, {
      tool_calls: [
        {
          index: toolCallIndex,
          id: event.item.call_id ?? event.item.id ?? `call_${toolCallIndex}`,
          type: "function",
          function: {
            name: event.item.name,
            arguments: "",
          },
        },
      ],
    })
  }

  if (event.type === "response.function_call_arguments.delta") {
    const outputIndex = event.output_index ?? 0
    const toolCallIndex = state.toolCallMap.get(outputIndex)

    if (toolCallIndex === undefined) {
      return null
    }

    return createChunk(state, {
      tool_calls: [
        {
          index: toolCallIndex,
          function: {
            arguments: event.delta ?? "",
          },
        },
      ],
    })
  }

  if (event.type === "response.done") {
    state.id = event.response?.id ?? state.id
    state.model = event.response?.model ?? state.model
    state.created = event.response?.created_at ?? state.created

    return {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: state.hasToolCalls ? "tool_calls" : "stop",
          logprobs: null,
        },
      ],
      usage:
        event.response?.usage ? {
          prompt_tokens: event.response.usage.input_tokens ?? 0,
          completion_tokens: event.response.usage.output_tokens ?? 0,
          total_tokens: event.response.usage.total_tokens ?? 0,
        } : undefined,
    }
  }

  return null
}

function createChunk(
  state: ResponsesStreamState,
  delta: ChatCompletionChunk["choices"][number]["delta"],
): ChatCompletionChunk {
  return {
    id: state.id,
    object: "chat.completion.chunk",
    created: state.created,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
        logprobs: null,
      },
    ],
  }
}

function translateChatMessageToResponsesInput(message: Message): string {
  const content = stringifyMessageContent(message.content)

  if (message.role === "tool") {
    return `tool (${message.tool_call_id ?? "unknown"}): ${content}`
  }

  const toolCalls = message.tool_calls?.length ? `\n${stringifyToolCalls(message.tool_calls)}` : ""
  return `${message.role}: ${content}${toolCalls}`.trim()
}

function stringifyToolCalls(
  toolCalls: NonNullable<Message["tool_calls"]>,
): string {
  return toolCalls
    .map(
      (toolCall) =>
        `tool_call (${toolCall.id}): ${toolCall.function.name}(${toolCall.function.arguments})`,
    )
    .join("\n")
}

function translateTools(
  tools: ChatCompletionsPayload["tools"],
): Array<ResponsesTool> | undefined {
  if (!tools?.length) {
    return undefined
  }

  return tools.map((tool: Tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

function translateToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): ResponsesApiRequest["tool_choice"] {
  if (!toolChoice) {
    return undefined
  }

  if (typeof toolChoice === "string") {
    return toolChoice
  }

  return {
    type: toolChoice.type,
    name: toolChoice.function.name,
  }
}

function translateResponsesToolsToChat(
  tools: ResponsesApiRequest["tools"],
): ChatCompletionsPayload["tools"] {
  if (!tools?.length) {
    return undefined
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {},
    },
  }))
}

function translateResponsesToolChoiceToChat(
  toolChoice: ResponsesApiRequest["tool_choice"],
): ChatCompletionsPayload["tool_choice"] {
  if (!toolChoice) {
    return undefined
  }

  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
      return toolChoice
    }

    return undefined
  }

  if (toolChoice.type === "function" && toolChoice.name) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    }
  }

  return undefined
}

function stringifyMessageContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content
    .map((part) => stringifyContentPart(part))
    .filter(Boolean)
    .join("\n")
}

function stringifyContentPart(part: ContentPart): string {
  if (part.type === "text") {
    return part.text
  }

  return `[image: ${part.image_url.url}]`
}

function stringifyResponsesInputItem(item: ResponsesInputItem): string {
  const content = stringifyResponsesContent(item.content)

  if (item.type === "tool_result") {
    return `tool (${item.tool_call_id ?? "unknown"}): ${item.output ?? content}`
  }

  return `${item.role}: ${content}`
}

function stringifyResponsesContent(
  content: string | Array<ResponsesContentPart>,
): string {
  if (typeof content === "string") {
    return content
  }

  return content
    .map((part) => {
      if ((part.type === "input_text" || part.type === "output_text") && part.text) {
        return part.text
      }

      if (part.type === "input_image" && part.image_url) {
        return `[image: ${part.image_url}]`
      }

      return ""
    })
    .filter(Boolean)
    .join("\n")
}
