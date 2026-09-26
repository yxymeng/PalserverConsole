import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { workSuitabilities } from "./palWorkSuitabilities";

test("全部工作技能在同一张表中映射到对应的游戏原始透明 PNG", () => {
  const mappings = { EmitFlame: "00", Watering: "01", Seeding: "02", GenerateElectricity: "03", Handcraft: "04", Collection: "05", Deforest: "06", Mining: "07", OilExtraction: "09", ProductMedicine: "08", Cool: "10", Transport: "11", MonsterFarm: "12" };
  expect(Object.keys(workSuitabilities)).toEqual(Object.keys(mappings));
  for (const [type, number] of Object.entries(mappings)) {
    const { label, icon } = workSuitabilities[type];
    expect(label).not.toBe("");
    expect(icon).toBe(`/assets/work-suitabilities/T_icon_palwork_${number}.png`);
    const png = readFileSync(new URL(`../../../public${icon}`, import.meta.url));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const size = type === "OilExtraction" ? 40 : 64;
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[25]).toBe(6); // RGBA，保留游戏纹理的透明通道。
  }
});
