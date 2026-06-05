import { LLMProvider, MeetingSummary } from "./llm/interface";
import { createProvider } from "./llm";

let provider: LLMProvider | null = null;

/**
 * Get or initialize the LLM provider.
 * Lazy initialization so config is ready when first called.
 */
async function getProvider(): Promise<LLMProvider> {
  if (!provider) {
    provider = createProvider();
  }
  return provider;
}

export interface SummarizedMeeting {
  summary: string;
  bulletPoints: string[];
  tasks: MeetingSummary["tasks"];
  futureProspects: string[];
  marketingTopics: string[];
}

/**
 * Summarize a meeting transcript using the configured LLM provider.
 */
export async function summarizeMeeting(
  transcript: string,
  options?: { meetingTitle?: string; marketingTopics?: string[] }
): Promise<SummarizedMeeting> {
  if (!transcript || transcript.trim().length < 20) {
    throw new Error("Transcript is too short or empty — cannot generate summary");
  }

  const llm = await getProvider();
  const result = await llm.summarize(transcript, options);

  // Generate a structured markdown summary
  const summaryHeader = options?.meetingTitle
    ? `# ${options.meetingTitle}\n\n`
    : "# Meeting Summary\n\n";

  const bulletSection = [
    "## Key Discussion Points\n",
    ...result.bulletPoints.map((bp) => `- ${bp}`),
  ].join("\n");

  const tasksSection = result.tasks.length > 0
    ? [
        "\n\n## Action Items\n",
        ...result.tasks.map((t) => {
          const assignee = t.assignee ? ` — @${t.assignee}` : "";
          const priorityTag = t.priority === "high" ? " 🔴" : t.priority === "medium" ? " 🟡" : " 🟢";
          return `- [ ] ${t.description}${assignee}${priorityTag}`;
        }),
      ].join("\n")
    : "";

  const prospectsSection = result.futureProspects.length > 0
    ? [
        "\n\n## Future Prospects\n",
        ...result.futureProspects.map((fp) => `- ${fp}`),
      ].join("\n")
    : "";

  const topicsSection = result.marketingTopics.length > 0
    ? `\n\n---\n*Topics: ${result.marketingTopics.join(" · ")}*`
    : "";

  const summary = [
    summaryHeader,
    bulletSection,
    tasksSection,
    prospectsSection,
    topicsSection,
  ].join("");

  return {
    summary,
    bulletPoints: result.bulletPoints,
    tasks: result.tasks,
    futureProspects: result.futureProspects,
    marketingTopics: result.marketingTopics,
  };
}
