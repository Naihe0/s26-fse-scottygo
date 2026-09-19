/**
 * LLM Content Moderation Service (R11)
 *
 * Checks free-text bus report comments for inappropriate content using
 * the Google Gemini API. Falls back to a basic keyword filter when the
 * API key is not configured or the API call fails.
 */

import { GEMINI_API_KEY, GEMINI_MODEL } from '../env';

function tag(): string {
  return `[ModerationService ${new Date().toISOString()}]`;
}

export interface IModerationResult {
  flagged: boolean;
  reason?: string;
  category?: 'inappropriate' | 'irrelevant';
}

/** Basic blocklist for the fallback filter. */
const BLOCKED_PATTERNS = [
  /\b(fuck|shit|damn|ass|bitch|bastard|crap|piss|dick|cock|cunt)\b/i,
  /\b(kill|murder|bomb|threat|attack|terroris[tm])\b/i,
  /\b(hate\s+(you|them|everyone|all))\b/i
];

/** Gemini API base URL */
const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

class ModerationService {
  /**
   * Moderate a comment string.
   * Uses Gemini LLM if configured, otherwise falls back to keyword filter.
   * Returns { flagged: true, reason, category } for flagged comments.
   */
  async moderate(comment: string): Promise<IModerationResult> {
    if (!comment || comment.trim().length === 0) {
      return { flagged: false };
    }

    if (GEMINI_API_KEY) {
      try {
        return await this.geminiModerate(comment);
      } catch (err) {
        console.error(
          `${tag()} Gemini moderation failed, falling back to keyword filter:`,
          err instanceof Error ? err.message : err
        );
        return this.keywordFilter(comment);
      }
    }

    return this.keywordFilter(comment);
  }

  private async geminiModerate(comment: string): Promise<IModerationResult> {
    const url = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `You are a content moderation system for a public transit app.

  Analyze the following user comment and decide whether it should be flagged.

  Flag the comment if it is EITHER:
  1) Inappropriate: profanity, hate speech, threats, harassment, or sexually explicit content.
  2) Irrelevant: not meaningfully related to a bus ride, route/service conditions, accessibility, timing/delays, cleanliness, crowding, seating availability, safety, stops, or driver behavior.

  Do NOT flag short but relevant comments, including uncertain ones like "not sure", if they are clearly about transit context.

  Respond with ONLY a JSON object in this exact format, with no extra text:
  {"flagged": true/false, "reason": "brief explanation if flagged", "category": "inappropriate|irrelevant|none"}

  Comment to analyze: "${comment.replace(/"/g, '\\"')}"`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 100
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini API returned HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Parse the JSON response from Gemini
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      console.warn(
        `${tag()} Could not parse Gemini response, falling back to keyword filter`
      );
      return this.keywordFilter(comment);
    }

    const result = JSON.parse(jsonMatch[0]);
    if (result.flagged) {
      console.log(`${tag()} Comment flagged by Gemini: ${result.reason}`);
    }
    const categoryRaw =
      typeof result.category === 'string' ? result.category.toLowerCase() : '';
    const normalizedCategory: IModerationResult['category'] =
      categoryRaw === 'irrelevant'
        ? 'irrelevant'
        : result.flagged
          ? 'inappropriate'
          : undefined;

    return {
      flagged: !!result.flagged,
      reason: result.reason,
      category: normalizedCategory
    };
  }

  private keywordFilter(comment: string): IModerationResult {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(comment)) {
        console.log(`${tag()} Comment flagged by keyword filter`);
        return {
          flagged: true,
          reason: 'Comment contains inappropriate language.',
          category: 'inappropriate'
        };
      }
    }
    return { flagged: false };
  }
}

const moderationService = new ModerationService();
export default moderationService;
