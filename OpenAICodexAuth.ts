export interface OpenAICodexOAuthTokens {
  access: string;
  refresh: string;
  expires: number;
}

export interface OpenAICodexOAuthCredentials extends OpenAICodexOAuthTokens {
  type: "oauth";
  accountId: string;
}

const OPENAI_CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("OpenAI Codex access token is not a valid JWT");
  }

  const encodedPayload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const paddedPayload = encodedPayload.padEnd(
    encodedPayload.length + ((4 - encodedPayload.length % 4) % 4),
    "="
  );

  try {
    const payload = JSON.parse(
      Buffer.from(paddedPayload, "base64").toString("utf8")
    ) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JWT payload is not an object");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `OpenAI Codex access token payload could not be decoded: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function extractOpenAICodexAccountId(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken);
  const authClaim = payload[OPENAI_CODEX_AUTH_CLAIM];
  const nestedAccountId =
    authClaim && typeof authClaim === "object" && !Array.isArray(authClaim)
      ? (authClaim as Record<string, unknown>).chatgpt_account_id
      : undefined;

  // The nested claim is the current official shape. The fallbacks keep
  // credentials readable if OpenAI ever emits the same identifier at the
  // top level or an older Pi-compatible shape.
  const accountId =
    nestedAccountId ?? payload.chatgpt_account_id ?? payload.accountId;
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw new Error(
      "OpenAI Codex token response is missing chatgpt_account_id"
    );
  }
  return accountId.trim();
}

export function createOpenAICodexOAuthCredentials(
  tokens: OpenAICodexOAuthTokens
): OpenAICodexOAuthCredentials {
  if (!tokens.access.trim() || !tokens.refresh.trim()) {
    throw new Error("OpenAI Codex OAuth token response is incomplete");
  }
  if (!Number.isFinite(tokens.expires) || tokens.expires <= 0) {
    throw new Error("OpenAI Codex OAuth token expiry is invalid");
  }

  return {
    type: "oauth",
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expires,
    accountId: extractOpenAICodexAccountId(tokens.access),
  };
}

/**
 * Repair credentials written by Pimate versions that passed an OAuth JSON
 * string through the generic API-key writer.
 */
export function migrateLegacyOpenAICodexCredential(
  value: unknown
): OpenAICodexOAuthCredentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  if (entry.type !== "api_key" || typeof entry.key !== "string") {
    return null;
  }

  let legacy: Record<string, unknown>;
  try {
    const parsed = JSON.parse(entry.key) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    legacy = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  if (
    legacy.type !== "oauth" ||
    typeof legacy.access !== "string" ||
    typeof legacy.refresh !== "string" ||
    typeof legacy.expires !== "number"
  ) {
    return null;
  }

  try {
    const accountId =
      typeof legacy.accountId === "string" && legacy.accountId.trim()
        ? legacy.accountId.trim()
        : extractOpenAICodexAccountId(legacy.access);
    return {
      type: "oauth",
      access: legacy.access,
      refresh: legacy.refresh,
      expires: legacy.expires,
      accountId,
    };
  } catch {
    return null;
  }
}
