import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { ResponsesApiRequest, ResponsesApiResponse } from "~/routes/responses/types"

import {
  normalizeResponsesRequest,
  translateChatToResponsesRequest,
  translateResponsesToChatPayload,
  translateResponsesToChatResponse,
} from "~/routes/responses/translation"

describe("Responses translation", () => {
  test("translates chat payload to string-based responses request", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 128,
      stream: false,
    }

    const request = translateChatToResponsesRequest(payload)

    expect(request.instructions).toBe("Be concise.")
    expect(request.input).toBe("user: Hello")
    expect(request.max_output_tokens).toBe(128)
  })

  test("normalizes structured responses input into a string", () => {
    const request: ResponsesApiRequest = {
      model: "gpt-5.4",
      input: [
        { role: "developer", content: "Follow the rules." },
        {
          role: "user",
          content: [{ type: "input_text", text: "Hi there" }],
        },
      ],
    }

    const normalized = normalizeResponsesRequest(request)

    expect(normalized.instructions).toBe("developer: Follow the rules.")
    expect(normalized.input).toBe("user: Hi there")
  })

  test("translates responses output back to chat completion shape", () => {
    const response: ResponsesApiResponse = {
      id: "resp_123",
      object: "response",
      created_at: 1,
      model: "gpt-5.4",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Hello back" }],
        },
      ],
      output_text: "Hello back",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      },
      status: "completed",
    }

    const chat = translateResponsesToChatResponse(response)

    expect(chat.object).toBe("chat.completion")
    expect(chat.choices[0]?.message.content).toBe("Hello back")
    expect(chat.usage?.prompt_tokens).toBe(10)
    expect(chat.usage?.completion_tokens).toBe(5)
  })

  test("translates function tools to responses top-level name shape", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Check weather" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "get_weather" },
      },
    }

    const request = translateChatToResponsesRequest(payload)

    expect(request.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
        },
      },
    ])
    expect(request.tool_choice).toEqual({
      type: "function",
      name: "get_weather",
    })
  })

  test("builds a chat payload from a responses request for token counting", () => {
    const payload = translateResponsesToChatPayload({
      model: "gpt-5.4",
      instructions: "Be concise.",
      input: "user: Hello",
      max_output_tokens: 256,
      tools: [
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object" },
        },
      ],
      tool_choice: {
        type: "function",
        name: "get_weather",
      },
    })

    expect(payload.messages).toEqual([
      { role: "system", content: "Be concise." },
      { role: "user", content: "user: Hello" },
    ])
    expect(payload.max_tokens).toBe(256)
    expect(payload.tools?.[0]?.function.name).toBe("get_weather")
    expect(payload.tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    })
  })
})
