export type ApiError = { errorCode?: string; message?: string; retryable?: boolean };

export class ApiRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = "ApiRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function requestJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as ApiError;
    throw new ApiRequestError(
      error.errorCode || `HTTP_${response.status}`,
      error.message || `${response.status} ${response.statusText}`,
      error.retryable,
    );
  }
  return (await response.json()) as T;
}
