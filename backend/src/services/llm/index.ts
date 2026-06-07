import { config } from "../../config";
import { LLMProvider } from "./interface";
import { DeepSeekProvider } from "./deepseek";

/**
 * LLM config override from user headers.
 */
export interface LlmConfig {
  provider: string;
  apiKey?: string;
  model?: string;
  baseURL?: string;
}

/**
 * Factory: create the configured LLM provider.
 *
 * If `override` is provided, it creates a provider with those settings
 * instead of using the default config. This allows users to supply their
 * own LLM API key/model from the frontend.
 *
 * To add a new provider:
 * 1. Create a new file (e.g., claude.ts, openai.ts) implementing LLMProvider
 * 2. Import it here
 * 3. Add a case to the switch below
 */
export function createProvider(override?: LlmConfig): LLMProvider {
  const providerName = override?.provider || config.llm.provider;

  switch (providerName) {
    case "deepseek":
    case "openai": // OpenAI-compatible (same constructor pattern)
      return new DeepSeekProvider(override);
    // Future providers:
    // case "claude":
    //   return new ClaudeProvider(override);
    default:
      throw new Error(
        `Unknown LLM provider: ${providerName}. ` +
          `Supported: deepseek, openai (add claude in llm/index.ts)`
      );
  }
}
