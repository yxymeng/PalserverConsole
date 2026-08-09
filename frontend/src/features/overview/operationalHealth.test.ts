import { describe, expect, it } from "vitest";
import { healthStateLabel, healthStateTone } from "./operationalHealth";

describe("operational health presentation", () => {
  it("distinguishes missing, stale, failed, and stopped data", () => {
    expect(healthStateLabel("no_data")).toBe("无数据");
    expect(healthStateLabel("stale")).toBe("数据较旧");
    expect(healthStateLabel("failed")).toBe("解析失败");
    expect(healthStateLabel("stopped")).toBe("后台已停止");
    expect(healthStateTone("blocked")).toBe("danger");
  });
});
