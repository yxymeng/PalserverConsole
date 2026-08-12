type PalSource = Record<string, unknown>;

export type PalCatalogEntry = {
  name: string;
  iconKey: string;
};

// 名称资料与图标资源保持解耦。当前只收录已由本项目解析 fixture 验证过的 Character ID。
export const PAL_CATALOG: Record<string, PalCatalogEntry> = {
  SheepBall: { name: "棉悠悠", iconKey: "sheepball" },
  CatMage: { name: "捣蛋猫", iconKey: "cat-mage" },
};

export type PalPresentation = PalCatalogEntry & {
  characterId: string;
  displayName: string;
  speciesName: string;
  known: boolean;
};

export function resolvePal(source: PalSource): PalPresentation {
  const characterId = textValue(source.characterId);
  const nickname = textValue(source.nickname);
  const catalogEntry = PAL_CATALOG[characterId];
  const speciesName = catalogEntry?.name || characterId || "未知帕鲁";
  return {
    characterId: characterId || "未知",
    displayName: nickname || speciesName,
    speciesName,
    iconKey: catalogEntry?.iconKey || "pal-placeholder",
    name: catalogEntry?.name || speciesName,
    known: Boolean(catalogEntry),
  };
}

export function playerInitial(value: unknown): string {
  return Array.from(textValue(value))[0]?.toLocaleUpperCase("zh-CN") || "?";
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}
