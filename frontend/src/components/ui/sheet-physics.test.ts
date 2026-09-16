import { describe, expect, it } from "vitest";
import { rubberBand, sheetTarget } from "./sheet-physics";

describe("mobile sheet gestures", () => {
  it("projects the same release position to different anchors based on velocity", () => {
    expect(sheetTarget(560, 0, 500, 832)).toBe(500);
    expect(sheetTarget(560, 1000, 500, 832)).toBe(832);
    expect(sheetTarget(560, -2000, 500, 832)).toBe(0);
    expect(sheetTarget(800, 0, 500, 832)).toBe(832);
  });
  it("adds bounded, progressive resistance only beyond travel limits", () => {
    expect(rubberBand(400, 0, 832)).toBe(400);
    expect(rubberBand(900, 0, 832)).toBeGreaterThan(832);
    expect(rubberBand(900, 0, 832)).toBeLessThan(900);
    expect(rubberBand(10000, 0, 832)).toBeLessThan(880);
    expect(rubberBand(-1000, 0, 832)).toBeGreaterThan(-48);
  });
});
