import { writeJson } from "../lib/http";

export const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

export function decodeJwtPayload(token: string) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(decodeBase64Url(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function extractAccountId(accessToken: string, auth: { tokens?: { account_id?: string } } | null) {
  if (auth?.tokens?.account_id) return auth.tokens.account_id;
  const payload = decodeJwtPayload(accessToken);
  const authClaim = payload?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
  const accountId = authClaim?.chatgpt_account_id;
  if (typeof accountId === "string" && accountId.length > 0) return accountId;
  throw new Error("Could not extract chatgpt account id from Codex token");
}

export function tokenExpiresSoon(accessToken: string) {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  return exp * 1000 < Date.now() + 60_000;
}

type CodexAuthFile = {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
};

export async function refreshAccessToken(
  auth: CodexAuthFile,
  { authPath, tokenUrl, clientId }: { authPath: string; tokenUrl: string; clientId: string },
) {
  const refreshToken = auth?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error(`Missing refresh token in ${authPath}`);
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Codex token refresh failed (${response.status}): ${text || response.statusText}`);
  }

  const json = (await response.json()) as { access_token?: string; refresh_token?: string };
  if (!json?.access_token) {
    throw new Error(`Codex token refresh returned no access_token: ${JSON.stringify(json)}`);
  }

  auth.tokens = auth.tokens || {};
  auth.tokens.access_token = json.access_token;
  if (json.refresh_token) auth.tokens.refresh_token = json.refresh_token;
  auth.tokens.account_id = extractAccountId(json.access_token, auth);
  auth.last_refresh = new Date().toISOString();
  writeJson(authPath, auth);
  return auth;
}

export async function loadCodexAuth(
  readAuth: () => CodexAuthFile,
  options: {
    authPath: string;
    tokenUrl: string;
    clientId: string;
    forceRefresh?: boolean;
  },
) {
  const { authPath, tokenUrl, clientId, forceRefresh = false } = options;
  let auth = readAuth();
  const accessToken = auth?.tokens?.access_token;
  if (!accessToken) {
    throw new Error(`Missing access token in ${authPath}. Run Codex login first.`);
  }
  if (forceRefresh || tokenExpiresSoon(accessToken)) {
    auth = await refreshAccessToken(auth, { authPath, tokenUrl, clientId });
  }
  const token = auth.tokens!.access_token!;
  return { token, accountId: extractAccountId(token, auth) };
}
