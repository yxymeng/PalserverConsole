import { afterEach, expect, test, vi } from "vitest";

import { ApiRequestError, createIdempotencyKey, requestJson } from "./client";

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

test("createIdempotencyKey 在局域网 HTTP 环境缺少 randomUUID 时仍生成 UUID", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => {
    bytes.set(Array.from({ length: 16 }, (_, index) => index * 17));
    return bytes;
  });
  vi.stubGlobal("crypto", { getRandomValues });

  expect(createIdempotencyKey()).toBe("00112233-4455-4677-8899-aabbccddeeff");
  expect(getRandomValues).toHaveBeenCalledOnce();
});
