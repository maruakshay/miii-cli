export {
  PROVIDER_NAME,
  NOT_INSTALLED as OLLAMA_NOT_INSTALLED,
  isAvailable as ollamaInstalled,
  listModels,
  modelContext,
  chat,
} from '../llm/ollama.js'

export type { ChatOptions } from '../llm/types.js'
