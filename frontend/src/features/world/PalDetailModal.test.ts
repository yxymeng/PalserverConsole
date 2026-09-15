import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { WorldPalRosterItem } from "../../api/contracts";
import { PalDetailModal } from "./PalDetailModal";

const pal: WorldPalRosterItem = {
  id: "test", characterId: "SheepBall", nickname: null, level: 1, rank: null,
  ownerPlayerId: null, containerId: null, slotIndex: null, baseId: null,
  assignment: "unassigned", locationType: "unassigned", gender: null, isBoss: false, isLucky: false,
  aptitude: { speciesRarity: null, ivs: { hp: 60, attack: 58, defense: 60, average: 59.333333333333336 }, workSuitabilities: [], metadataKnown: false, metadataLabel: "资料未收录" },
  skills: { passive: [], equipped: [], learned: [], partner: null },
  care: { currentHp: null, hunger: 50.20763942173549, hungerRaw: null, hungerStatus: null, sanity: 0, physicalHealth: null, disease: null, activity: null, diseaseRecorded: false, activityRecorded: false, reasons: [], unavailable: [], severity: "healthy", attention: false },
};
const render = (data: WorldPalRosterItem) => renderToStaticMarkup(createElement(PalDetailModal, { data, onClose: () => {} }));

test("详情限制小数精度，保留零值与未知星级", () => {
  const html = render(pal).replace(/<[^>]*>/g, "");
  for (const value of ["50.2%", "59.3", "0%", "个体值（IV）"]) expect(html).toContain(value);
  for (const value of ["333333", "207639", "★ x0", "雷达"]) expect(html).not.toContain(value);
});

test("详情保留缺失个体值及原始饱食值的语义", () => {
  const data = { ...pal, aptitude: { ...pal.aptitude, ivs: { hp: null, attack: null, defense: null, average: null } }, care: { ...pal.care, sanity: null, hunger: null, hungerRaw: 50.20763942173549 } };
  const html = render(data);
  expect(html).toContain("原始值 50.2");
  expect(html).not.toContain("50.2%");
  expect(html).toContain("数据不可用");
  expect(html).toContain("<dd>不可用</dd>");
  expect(html).not.toContain("<dd>0</dd>");
  expect(render({ ...data, care: { ...data.care, hungerRaw: null } })).not.toContain("原始值");
});


test("数值型零标记不渲染为 00，真实昵称保留", () => {
  const data = { ...pal, isBoss: 0, isLucky: 0 } as unknown as WorldPalRosterItem;
  const html = render(data).replace(/<[^>]*>/g, "");
  expect(html).not.toContain("棉悠悠00");
  expect(html).not.toContain("巨型头目");
  expect(html).not.toContain("稀有闪光");
  expect(render({ ...data, nickname: "00" })).toContain("“00”");
});

test("详情只保留一个查找入口并隐藏内部代码，显示已有工作翻译", () => {
  const data = { ...pal, ownerPlayerId: "player-1", ownerName: "Alice", assignment: "player", aptitude: { ...pal.aptitude, workSuitabilities: [{ type: "MonsterFarm", level: 2 }, { type: "EmitFlame", level: 1 }, { type: "ProductMedicine", level: 1 }] }, skills: { ...pal.skills, passive: [{ id: "InternalPassiveCode", name: "电容", description: "雷属性攻击伤害增加{EffectValue1}%", sourceName: null, rank: 1, element: null, power: null, cooldown: null, metadataKnown: true }] } };
  // Detail responses use assignment rather than the roster's locationType.
  const detail = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "locationType")) as WorldPalRosterItem;
  const html = renderToStaticMarkup(createElement(PalDetailModal, { data: detail, onClose: () => {}, onFindSameSpecies: () => {} }));
  expect(html.match(/查找同种帕鲁/g)).toHaveLength(1);
  for (const label of ["牧场", "生火", "制药", "当前位置", "玩家持有 · Alice", "雷属性攻击伤害增加（数值未收录）"]) expect(html).toContain(label);
  for (const code of ["编号:", "InternalPassiveCode", "MonsterFarm", "{EffectValue1}", "Tier"]) expect(html).not.toContain(code);
});

test("详情将训练家或据点合并为唯一当前位置", () => {
  expect(render({ ...pal, locationType: "party", ownerPlayerId: "player-1", ownerName: "Alice" })).toContain("随身队伍 · Alice");
  expect(render({ ...pal, locationType: "storage", ownerPlayerId: "player-1", ownerName: "Alice" })).toContain("帕鲁终端 · Alice");
  expect(render({ ...pal, locationType: "base", baseId: "base-1", baseName: "据点甲" })).toContain("据点工作 · 据点甲");
  const unknown = render(pal);
  expect(unknown).toContain("归属资料不可用");
  for (const label of ["所属训练家", "存放位置", "野生 / 未登记"]) expect(unknown).not.toContain(label);
});
