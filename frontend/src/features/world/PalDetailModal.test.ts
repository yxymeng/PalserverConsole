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
