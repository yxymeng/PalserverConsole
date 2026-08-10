import { afterEach, expect, test, vi } from "vitest";

import { ApiRequestError, requestJson } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("requestJson 透传 AbortSignal 并使用同源凭据", async () => {
  const controller = new AbortController();
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ status: "ok" }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(requestJson<{ status: string }>("/api/health", { signal: controller.signal })).resolves.toEqual({ status: "ok" });
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/health",
    expect.objectContaining({ credentials: "same-origin", signal: controller.signal }),
  );
});

test("requestJson 将后端错误收敛为 ApiRequestError", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ errorCode: "OPERATION_IN_PROGRESS", message: "已有操作", retryable: true }), {
      headers: { "Content-Type": "application/json" },
      status: 409,
    }),
  ));

  await expect(requestJson("/api/server/operations/start")).rejects.toMatchObject({
    code: "OPERATION_IN_PROGRESS",
    retryable: true,
  } satisfies Partial<ApiRequestError>);
});
