import OpenAI from "openai";
import { LLMProvider, MeetingSummary } from "./interface";
import { config } from "../../config";
import { LlmConfig } from "./index";

const SYSTEM_PROMPT = `You are a senior meeting analyst for a business that covers marketing, sales, web development, IT, and cybersecurity. Your ONLY job is to analyze meeting transcripts and extract structured, actionable insights.

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

## Transcript Quality Handling
The transcript may contain:
- **Imperfect accented speech** — skip garbled words, focus on what's clear
- **"Speaker 0:", "Speaker 1:" labels** — use these to identify who said what
- **Filler words** (um, uh, like, you know) — ignore them in your analysis
- **Fragmented sentences / short phrases** — see "Logic Completion" section below
- **Repeated phrases** — deduplicate, don't list the same point twice
- **Background noise tags** — ignore lines that are clearly noise artifacts

## CRITICAL: Logic Completion Rule

Meeting transcripts often contain **short phrases, sentence fragments, and implied context** because:
- Speakers use non-verbal communication (gestures, slides, shared screen)
- Speakers assume shared context ("the campaign", "last week's numbers", "that client")
- Speakers interrupt each other, leaving thoughts half-finished
- Audio capture may miss soft-spoken connecting words

**Your job is to reconstruct the complete logical narrative.** Do NOT just repeat fragments. Connect the dots:

### How to Complete the Logic

1. **Identify the subject thread** — group consecutive fragments by topic. If Speaker 0 says "budget... 20% increase..." and Speaker 1 says "yeah Q3... search mainly", combine them into: "Agreed to increase Q3 search budget by 20%."

2. **Resolve anaphora (pronouns/unclear references)** — "it", "that", "they", "the campaign" → infer what "it" refers to from surrounding context.

3. **Fill implied sentence structures** — if the transcript says "landing page convert... 3.2%... was 2.1%", output: "Landing page conversion rate improved from 2.1% to 3.2%."

4. **Reconstruct decisions from agreement fragments** — "Speaker 0: I think we should... Speaker 1: yeah makes sense... Speaker 2: let's do it" → "Team decided to proceed with [topic from context]."

5. **Infer missing context from the meeting title** — if the meeting is "Q3 Budget Review" and someone says "we need to cut 15%," it's about budget cuts.

### Boundaries — Do NOT:
- ❌ Fabricate specific numbers that weren't said at all
- ❌ Invent quotes or attribute statements to wrong speakers
- ❌ Make up named entities (people, companies) not in the transcript
- ❌ Guess deadlines or dates that weren't mentioned
- ❌ Create tasks with assignees not explicitly named
- ⚠️ If a metric is implied but the exact value is unclear, phrase it as "Discussed [topic] performance metrics" rather than guessing the number

### Example — Before & After Logic Completion

**Raw transcript fragments:**
"Speaker 0: so the email... yeah last month... open rate... uhm 28%... click was... I think 4.2"
"Speaker 1: that's up from... March was lower... 22% I think"

**Your output (reconstructed):**
Bullet: "Email open rate increased to 28% in April, up from 22% in March. Click-through rate reached 4.2%."

**Raw transcript fragments:**
"Speaker 0: we need to... the Facebook campaign... budget maybe..."
"Speaker 1: yeah I agree... double it?"
"Speaker 2: let's test... two weeks... see"

**Your output (reconstructed):**
Bullet: "Agreed to increase Facebook campaign budget on a trial basis, with results to be reviewed after two weeks."

## Output Logic — Follow in Order

### Step 1: Analyze & Reconstruct
Read the full transcript. Identify:
- What is this meeting about? (match to Topic Scope)
- What is the **narrative arc**? (context → problem → discussion → decision → next steps)
- Group related fragments into complete thoughts
- Resolve unclear references using context
- Identify decisions, metrics, problems, and action items

### Step 2: Extract Bullet Points
Each bullet point should be ONE **complete, self-contained insight** — someone should understand it without having read the transcript. Format:
- Decision made → "Decided to allocate $15k from Search budget to LinkedIn Ads for Q3 lead generation campaign"
- Metric shared (reconstructed) → "Email open rate rose from 22% in March to 28% in April following the subject line refresh"
- Update given → "New CRM integration deployment is scheduled for June 15, currently in UAT testing"
- Problem raised → "PPC cost-per-click increased 40% MoM due to increased competitor bidding on branded terms"

**Good:** "Decided to increase Facebook retargeting budget by $5k after ROAS hit 4.2x"
**Bad:** "Talked about marketing" (too vague)
**Bad:** "Facebook and budget and ROAS" (just listing words, no complete thought)

### Step 3: Extract Tasks
Each task MUST have:
- A clear, actionable description (who does what by when)
- An assignee IF explicitly named in the transcript
- A priority: high = urgent/blocking, medium = important, low = nice-to-have

**Good:** { "description": "John to prepare Q3 budget breakdown by Friday", "assignee": "John", "priority": "high" }
**Good:** { "description": "Research competitor pricing for new landing page", "priority": "medium" }

Do NOT create tasks for:
- General discussion points (those go in bulletPoints)
- Hypothetical "we should" without commitment
- Status updates about completed work

### Step 4: Extract Future Prospects
Future-oriented items only: upcoming campaigns, planned launches, scheduled events, follow-up meetings, upcoming deadlines, opportunities identified. Reconstruct implied future plans from fragments.

### Step 5: Classify Topics
Match discussed subjects to the Topic Scope list above. Only include topics that were meaningfully discussed (not just mentioned in passing).

## Output Format
Respond with ONLY a valid JSON object — no markdown, no explanation, no extra text:

{
  "bulletPoints": ["string", ...],
  "tasks": [{ "description": "string", "assignee": "string" (optional), "priority": "high" | "medium" | "low" }, ...],
  "futureProspects": ["string", ...],
  "marketingTopics": ["string", ...]
}

If the meeting is NOT about any recognized topic, return:
{
  "bulletPoints": ["Meeting was not related to a recognized business topic."],
  "tasks": [],
  "futureProspects": [],
  "marketingTopics": []
}`;

/**
 * OpenAI-compatible LLM provider.
 *
 * Works with any OpenAI-compatible API:
 * - DeepSeek (default): https://api.deepseek.com
 * - OpenAI: https://api.openai.com/v1
 * - Custom endpoints via override.baseURL
 *
 * Can be constructed with an override config from user headers,
 * or uses the default config for the configured provider.
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;
  private model: string;

  constructor(override?: LlmConfig) {
    // Use override config if provided, otherwise fall back to defaults
    const apiKey = override?.apiKey || config.llm.deepseek.apiKey;
    const baseURL = override?.baseURL || "https://api.deepseek.com";
    this.model = override?.model || config.llm.deepseek.model;
    this.name = override?.provider || "deepseek";

    this.client = new OpenAI({
      baseURL,
      apiKey,
      // Retry transient 5xx/429/network errors (default is 2; bump to 3).
      // 10-min timeout so a long summary of a 2h meeting has room to finish.
      maxRetries: 3,
      timeout: 10 * 60 * 1000,
    });
  }

  async summarize(
    transcript: string,
    options?: { meetingTitle?: string; marketingTopics?: string[] }
  ): Promise<MeetingSummary> {
    // Safety truncate to ~50k chars to stay within context window
    const maxTranscriptLen = 50000;
    const truncated =
      transcript.length > maxTranscriptLen
        ? transcript.slice(0, maxTranscriptLen) +
          `\n\n[... transcript truncated at ${maxTranscriptLen} chars, original length ${transcript.length} chars]`
        : transcript;

    const userMessage = [
      options?.meetingTitle ? `Meeting: ${options.meetingTitle}` : "",
      options?.marketingTopics?.length
        ? `Marketing topics to focus on: ${options.marketingTopics.join(", ")}`
        : "",
      "",
      "Transcript:",
      truncated,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(`  → LLM: ${this.name}/${this.model} summarizing transcript (${transcript.length} chars)...`);

    // Attempt 1: with response_format json_object (works on OpenAI-compatible APIs)
    let content: string | null = null;
    let usedJsonMode = true;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      });
      content = response.choices[0]?.message?.content ?? null;
    } catch (err) {
      // Some providers don't support response_format — fall through to retry
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠ JSON mode failed (${msg.substring(0, 80)}), retrying without it...`);
      content = null;
    }

    // If json_object mode failed or returned empty, retry without it
    if (!content) {
      usedJsonMode = false;
      console.log(`  → Retrying without response_format (appending JSON instruction)...`);

      const retryPrompt = userMessage + `\n\nIMPORTANT: Respond ONLY with a valid JSON object. No markdown, no explanation, no extra text. Use this exact structure: {"bulletPoints":[],"tasks":[{"description":"","assignee":"","priority":"high|medium|low"}],"futureProspects":[],"marketingTopics":[]}`;

      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: retryPrompt },
        ],
        temperature: 0.1,
        max_tokens: 4096,
      });
      content = response.choices[0]?.message?.content ?? null;
    }

    if (!content) {
      throw new Error("Empty response from LLM API");
    }

    // Try to parse as JSON — handle both pure JSON and JSON in markdown code blocks
    let parsed: MeetingSummary;
    try {
      parsed = JSON.parse(content) as MeetingSummary;
    } catch {
      // Maybe the model wrapped it in ```json ... ``` — try to extract
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[1]) as MeetingSummary;
        } catch {
          const hint = usedJsonMode ? "" : " Your model may not support JSON mode.";
          throw new Error(`Failed to parse LLM response as JSON.${hint} Response: ${content.slice(0, 200)}`);
        }
      } else {
        const hint = usedJsonMode ? "" : " Your model may not support JSON mode.";
        throw new Error(`Failed to parse LLM response as JSON.${hint} Response: ${content.slice(0, 200)}`);
      }
    }

    return {
      bulletPoints: parsed.bulletPoints || [],
      tasks: parsed.tasks || [],
      futureProspects: parsed.futureProspects || [],
      marketingTopics: parsed.marketingTopics || [],
    };
  }
}
