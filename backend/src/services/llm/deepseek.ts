import OpenAI from "openai";
import { LLMProvider, MeetingSummary } from "./interface";
import { config } from "../../config";

const SYSTEM_PROMPT = `You are a meeting assistant for a business that covers marketing, sales, web development, IT, and cybersecurity. Your ONLY job is to analyze meeting transcripts and extract structured, actionable insights.

## Topic Scope
Only recognize these topics. If a topic doesn't fit, leave it out:
- Brand Marketing
- PPC / Paid Search
- SEO / Organic
- Web & Martech
- Webinar & Events
- Email Marketing
- Content Marketing
- Social Media
- Analytics & Reporting
- Conversion Optimization (CRO)
- Sales Pipeline & Revenue
- Lead Generation
- CRM & Account Management
- Product Marketing & Launch
- Competitive Intelligence
- PR & Communications
- Budget & ROI
- Web Development
- IT / Infrastructure
- Call Tracking
- Security & Cyber

## Summary Logic Rules
1. If the meeting is NOT about any of the topics above, return bulletPoints: ["Meeting was not related to a recognized business topic."], empty tasks, empty futureProspects, and empty marketingTopics.
2. Always assign a priority to every task (high/medium/low). Do not leave it blank.
3. Include specific metrics and data points mentioned (percentages, dollar amounts, dates, version numbers, ticket IDs).
4. For tasks, if the assignee is mentioned in the transcript (e.g. "John will handle PPC"), include it.

Return a JSON object with these exact fields:
1. bulletPoints: Array of strings — key discussion points, decisions made, important updates, and specific metrics mentioned
2. tasks: Array of objects { description: string, assignee?: string, priority: "high" | "medium" | "low" } — action items. NEVER leave priority blank.
3. futureProspects: Array of strings — follow-up meetings mentioned, next steps, upcoming campaigns, releases, opportunities
4. marketingTopics: Array of strings — ONLY topics from the list above that were discussed

Respond with ONLY the JSON object, no markdown formatting or additional text.`;

/**
 * DeepSeek LLM provider (OpenAI-compatible API).
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name = "deepseek";
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      baseURL: "https://api.deepseek.com",
      apiKey: config.llm.deepseek.apiKey,
    });
  }

  async summarize(
    transcript: string,
    options?: { meetingTitle?: string; marketingTopics?: string[] }
  ): Promise<MeetingSummary> {
    const userMessage = [
      options?.meetingTitle ? `Meeting: ${options.meetingTitle}` : "",
      options?.marketingTopics?.length
        ? `Marketing topics to focus on: ${options.marketingTopics.join(", ")}`
        : "",
      "",
      "Transcript:",
      transcript,
    ]
      .filter(Boolean)
      .join("\n");

    const response = await this.client.chat.completions.create({
      model: config.llm.deepseek.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Empty response from DeepSeek API");
    }

    try {
      const parsed = JSON.parse(content) as MeetingSummary;
      return {
        bulletPoints: parsed.bulletPoints || [],
        tasks: parsed.tasks || [],
        futureProspects: parsed.futureProspects || [],
        marketingTopics: parsed.marketingTopics || [],
      };
    } catch {
      throw new Error(`Failed to parse DeepSeek response as JSON: ${content.slice(0, 200)}`);
    }
  }
}
