import { config } from "../../config";
import { LLMProvider } from "./interface";
import { DeepSeekProvider } from "./deepseek";

/**
 * Factory: create the configured LLM provider.
 *
 * To add a new provider:
 * 1. Create a new file (e.g., claude.ts, openai.ts) implementing LLMProvider
 * 2. Import it here
 * 3. Add a case to the switch below
 */
export function createProvider(): LLMProvider {
  switch (config.llm.provider) {
    case "deepseek":
      return new DeepSeekProvider();
    // Future providers:
    // case "claude":
    //   return new ClaudeProvider();
    // case "openai":
    //   return new OpenAIProvider();
    default:
      throw new Error(
        `Unknown LLM provider: ${config.llm.provider}. ` +
          `Supported: deepseek (add claude/openai in llm/index.ts)`
      );
  }
}
