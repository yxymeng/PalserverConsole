import { describe, expect, it } from "vitest";

import { activityLabel, diseaseLabel } from "./palCare";

describe("Pal care labels", () => {
  it("maps disease enums observed in real saves", () => {
    expect(diseaseLabel("EPalBaseCampWorkerSickType::GastricUlcer")).toBe("胃溃疡");
    expect(diseaseLabel("EPalBaseCampWorkerSickType::DepressionSprain")).toBe("抑郁症");
  });

  it("treats the saved current work suitability as working activity", () => {
    expect(activityLabel("EPalWorkSuitability::Mining")).toBe("工作中");
  });
});
