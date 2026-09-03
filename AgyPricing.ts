/**
 * Gemini API Standard pricing used to estimate the cost of AGY usage.
 *
 * AGY authenticates through the Antigravity account and does not expose an
 * invoice or billing account to Pimate. These rates are therefore estimates,
 * not a claim about the user's AGY subscription bill. The official page also
 * lists a separate cache-storage hourly fee, which cannot be derived from the
 * stream usage payload and is intentionally not included here.
 */

export const AGY_GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";

export interface AgyCostUsage {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  total: number;
}

export interface AgyModelPricing {
  modelFamily: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
}

const MILLION = 1_000_000;
const GEMINI_37_INTRODUCTORY_PRICE_END = Date.UTC(2027, 0, 1);

function modelFamily(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/-(low|medium|high)$/, "");
}

/**
 * Return the official Gemini API Standard rates for an AGY model slug.
 * Prices are USD per 1M tokens. Gemini 3.7/3.6 introductory rates change on
 * 2027-01-01, so historical reports use the rate active at each observation.
 */
export function getAgyModelPricing(
  modelId: string,
  at = Date.now()
): AgyModelPricing | null {
  const family = modelFamily(modelId);
  switch (family) {
    case "gemini-3.8-flash":
      return {
        modelFamily: family,
        inputPerMillion: 0.54,
        outputPerMillion: 4.5,
        cacheReadPerMillion: 0.054,
      };
    case "gemini-3.7-flash":
    case "gemini-3.6-flash": {
      const introductory = at < GEMINI_37_INTRODUCTORY_PRICE_END;
      return {
        modelFamily: family,
        inputPerMillion: introductory ? 0.75 : 1.5,
        outputPerMillion: introductory ? 3.75 : 7.5,
        cacheReadPerMillion: introductory ? 0.075 : 0.15,
      };
    }
    case "gemini-3.1-pro":
    case "gemini-3.1-pro-preview":
      return {
        modelFamily: family,
        inputPerMillion: 2.7,
        outputPerMillion: 16.2,
        cacheReadPerMillion: 0.27,
      };
    default:
      return null;
  }
}

/**
 * Estimate a completed AGY session/turn in USD.
 *
 * AGY's input_tokens includes cache_read_tokens. Subtract the cached portion
 * before applying the normal input rate, then price the cached portion at the
 * context-cache rate. Google prices output tokens including thinking tokens,
 * so thinking is not added a second time.
 */
export function calculateAgyCost(
  modelId: string,
  usage: AgyCostUsage,
  at = Date.now()
): number | null {
  const pricing = getAgyModelPricing(modelId, at);
  if (!pricing) return null;

  const input = Math.max(0, Number(usage.input) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  const cacheRead = Math.min(input, Math.max(0, Number(usage.cacheRead) || 0));
  const uncachedInput = input - cacheRead;
  return (
    uncachedInput * pricing.inputPerMillion
    + cacheRead * pricing.cacheReadPerMillion
    + output * pricing.outputPerMillion
  ) / MILLION;
}
