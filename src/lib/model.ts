import consola from "consola"

import { state } from "~/lib/state"
import type { Model } from "~/services/copilot/get-models"

const GPT_MODEL_REGEX = /^gpt-(\d+(?:\.\d+)?)/

export function getModelVersion(modelId: string): number {
  const versionMatch = modelId.match(GPT_MODEL_REGEX)
  return versionMatch ? Number.parseFloat(versionMatch[1]) : 0
}

export function shouldUseResponsesApi(modelId: string): boolean {
  return getModelVersion(modelId) >= 5.4
}

export function getOrCreateModel(modelId: string): Model | undefined {
  const existingModel = state.models?.data.find((model) => model.id === modelId)
  if (existingModel || !modelId.startsWith("gpt-")) {
    return existingModel
  }

  const version = getModelVersion(modelId)
  const model: Model = {
    capabilities: {
      family: `gpt-${Math.floor(version)}`,
      limits: {
        max_context_window_tokens: 128000,
        max_output_tokens: 4096,
        max_prompt_tokens: 128000,
      },
      object: "model_capabilities",
      supports: {
        tool_calls: true,
        parallel_tool_calls: true,
      },
      tokenizer: "o200k_base",
      type: "chat",
    },
    id: modelId,
    model_picker_enabled: true,
    name: modelId,
    object: "model",
    preview: true,
    vendor: "OpenAI",
    version: modelId,
  }

  consola.info(`Model ${modelId} not found in cache, creating dynamic definition`)

  if (state.models) {
    state.models.data.push(model)
  }

  return model
}
