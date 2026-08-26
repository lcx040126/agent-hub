export class AgentHubHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentHubHttpError";
  }
}

export interface AgentHubClientOptions {
  serverUrl: string;
  memberToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class AgentHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: AgentHubClientOptions) {
    this.baseUrl = normalizeServerUrl(options.serverUrl);
    if (!options.memberToken.trim()) throw new Error("An Agent Hub member token is required.");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get<T>(pathname: string): Promise<T> {
    return this.request<T>(pathname, { method: "GET" });
  }

  post<T>(pathname: string, body: unknown): Promise<T> {
    return this.request<T>(pathname, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  endpoint(pathname: string): URL {
    const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
    return new URL(`${this.baseUrl}${normalizedPath}`);
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint(pathname), {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.options.memberToken}`,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
        },
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) {
        const error = isRecord(payload) ? payload : {};
        throw new AgentHubHttpError(
          response.status,
          typeof error.error === "string" ? error.error : "request_failed",
          typeof error.message === "string"
            ? error.message
            : `Agent Hub returned HTTP ${response.status}.`,
          error.details,
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof AgentHubHttpError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Agent Hub did not respond within ${this.timeoutMs} ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Agent Hub requires an HTTP or HTTPS server URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The Agent Hub server URL cannot contain credentials, query, or fragment data.");
  }
  return url.toString().replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AgentHubHttpError(
      response.status,
      "invalid_response",
      "Agent Hub returned a response that was not valid JSON.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
