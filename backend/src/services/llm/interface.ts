/**
 * LLM Provider Interface
 *
 * Abstracts different LLM providers (DeepSeek, Claude, OpenAI) behind
 * a common contract. Add new providers by implementing this interface
 * and registering them in ../llm/index.ts
 */

export interface LLMProvider {
  /** Human-readable provider name */
  readonly name: string;

  /**
   * Summarize a meeting transcript into structured output.
   *
   * @param transcript - The full meeting transcript text
   * @param options - Optional context (meeting title, marketing topics)
   * @returns Structured summary with bullets, tasks, prospects, and topics
   */
  summarize(
    transcript: string,
    options?: {
      meetingTitle?: string;
      marketingTopics?: string[];
    }
  ): Promise<MeetingSummary>;
}

export interface MeetingSummary {
  /** Key discussion points and decisions */
  bulletPoints: string[];
  /** Action items extracted from the meeting */
  tasks: Array<{
    description: string;
    assignee?: string;
    priority?: "high" | "medium" | "low";
  }>;
  /** Follow-up meetings, next steps, opportunities */
  futureProspects: string[];
  /** Detected marketing topics discussed */
  marketingTopics: string[];
}
