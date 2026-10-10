import { afterEach, expect, test, vi } from "vitest";
import { createWorldDetailCache } from "./worldDetailCache";

afterEach(() => vi.unstubAllGlobals());
const response = (snapshotId = "world", id = "one") => new Response(JSON.stringify({ id, snapshotId }), { headers: { "Content-Type": "application/json" } });

test("预加载、点击和重复打开共享请求与缓存", async () => {
  let release: (response: Response) => void = () => {};
  const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const cache = createWorldDetailCache();
  cache.preload("players", "one", "world");
  const first = cache.load("players", "one", "world");
  expect(cache.load("players", "one", "world")).toBe(first);
  release(response());
  await first;
  expect(await cache.load("players", "one", "world")).toBe(cache.peek("players", "one", "world"));
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("快照、类型与页面实例隔离，快照变化不保留旧结果", async () => {
  const fetch = vi.fn((url: string) => Promise.resolve(response(new URL(url, "http://local").searchParams.get("snapshotId")!)));
  vi.stubGlobal("fetch", fetch);
  const cache = createWorldDetailCache();
  await cache.load("players", "one", "world");
  await cache.load("pals", "one", "world");
  await createWorldDetailCache().load("players", "one", "world");
  cache.retainSnapshot("next");
  expect(cache.peek("players", "one", "world")).toBeUndefined();
  expect((await cache.load("players", "one", "next")).snapshotId).toBe("next");
  expect(fetch).toHaveBeenCalledTimes(4);
});

test("失败与快照不匹配不入缓存，可以重试", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ errorCode: "WORLD_CACHE_UNAVAILABLE", message: "unavailable" }), { status: 503 }))
    .mockResolvedValueOnce(response("wrong"))
    .mockResolvedValueOnce(response());
  vi.stubGlobal("fetch", fetch);
  const cache = createWorldDetailCache();
  await expect(cache.load("players", "one", "world")).rejects.toThrow("WORLD_CACHE_UNAVAILABLE");
  await expect(cache.load("players", "one", "world")).rejects.toThrow("SNAPSHOT_REPLACED");
  expect(cache.peek("players", "one", "world")).toBeUndefined();
  await cache.load("players", "one", "world");
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("失效时取消旧请求，迟到响应不能覆盖新缓存", async () => {
  let release: (response: Response) => void = () => {};
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>(resolve => { release = resolve; });
  }).mockResolvedValueOnce(response());
  vi.stubGlobal("fetch", fetch);
  const cache = createWorldDetailCache();
  await cache.load("players", "one", "world");
  const old = cache.load("pals", "one", "world");
  cache.clear();
  expect(signal!.aborted).toBe(true);
  release(response());
  await expect(old).rejects.toMatchObject({ name: "AbortError" });
  expect(cache.peek("pals", "one", "world")).toBeUndefined();
});

test("预加载并发至多两个，缓存保留最近24个详情", async () => {
  const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  const cache = createWorldDetailCache();
  for (let id = 0; id < 10; id++) cache.preload("players", String(id), "world");
  expect(fetch).toHaveBeenCalledTimes(2);
  cache.clear();
  await Promise.resolve();
  fetch.mockImplementation((url: string) => Promise.resolve(response("world", new URL(url, "http://local").pathname.split("/").at(-1))));
  for (let id = 0; id < 25; id++) await cache.load("players", String(id), "world");
  expect(cache.peek("players", "0", "world")).toBeUndefined();
  expect(cache.peek("players", "24", "world")).toBeDefined();
});
