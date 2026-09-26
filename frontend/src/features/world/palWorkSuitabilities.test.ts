import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { workSuitabilities } from "./palWorkSuitabilities";

test("全部工作技能在同一张表中提供中文名称与内联 SVG", () => {
  expect(Object.keys(workSuitabilities)).toEqual(["EmitFlame", "Watering", "Seeding", "GenerateElectricity", "Handcraft", "Collection", "Deforest", "Mining", "OilExtraction", "ProductMedicine", "Cool", "Transport", "MonsterFarm"]);
  for (const { label, icon } of Object.values(workSuitabilities)) {
    expect(label).not.toBe("");
    const html = renderToStaticMarkup(createElement(icon, { size: 12, "aria-hidden": true }));
    for (const value of ['<svg', 'width="12"', 'height="12"', 'stroke="currentColor"', 'aria-hidden="true"']) expect(html).toContain(value);
    expect(html).not.toContain("<img");
  }
});
