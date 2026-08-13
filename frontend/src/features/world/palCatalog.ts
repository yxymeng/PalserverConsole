import catalogData from "./palCatalogData.json";

type PalSource = Record<string, unknown>;

export type PalCatalogEntry = {
  name: string;
  englishName: string;
  icon: string;
};

export type PalTraits = {
  gender: "male" | "female" | null;
  rank: number | null;
  isBoss: boolean;
  isPredator: boolean;
  isLucky: boolean;
  isAwakened: boolean;
  isImported: boolean;
};

export type PalPresentation = PalCatalogEntry & PalTraits & {
  characterId: string;
  displayName: string;
  speciesName: string;
  known: boolean;
};

export const PAL_CATALOG = catalogData as Record<string, PalCatalogEntry>;
export const UNKNOWN_PAL_ICON = "/assets/pals/T_icon_unknown.webp";
const PAL_CATALOG_CASE_INSENSITIVE = Object.fromEntries(
  Object.entries(PAL_CATALOG).map(([key, value]) => [key.toLocaleLowerCase("en-US"), value]),
);

export function resolvePal(source: PalSource): PalPresentation {
  const characterId = textValue(source.characterId);
  const nickname = textValue(source.nickname);
  const catalogEntry = PAL_CATALOG[characterId] || PAL_CATALOG_CASE_INSENSITIVE[characterId.toLocaleLowerCase("en-US")];
  const speciesName = catalogEntry?.name || characterId || "未知帕鲁";
  const detail = objectValue(source.detail);
  return {
    characterId: characterId || "未知",
    displayName: nickname || speciesName,
    speciesName,
    name: catalogEntry?.name || speciesName,
    englishName: catalogEntry?.englishName || characterId || "Unknown Pal",
    icon: catalogEntry?.icon || UNKNOWN_PAL_ICON,
    known: Boolean(catalogEntry),
    gender: genderValue(detail.gender),
    rank: numberValue(detail.rank),
    isBoss: booleanValue(detail.isBoss) || /^(BOSS_|GYM_)|Boss$/i.test(characterId),
    isPredator: booleanValue(detail.isPredator) || /^PREDATOR_/i.test(characterId),
    isLucky: booleanValue(detail.isLucky),
    isAwakened: booleanValue(detail.isAwakened),
    isImported: booleanValue(detail.isImported),
  };
}

export function palTraitLabels(source: PalSource): string[] {
  const pal = resolvePal(source);
  const labels: string[] = [];
  if (pal.isLucky) labels.push("闪光");
  if (pal.isBoss) labels.push("头目");
  if (pal.isPredator) labels.push("狂暴");
  if (pal.isAwakened) labels.push("觉醒");
  if (pal.isImported) labels.push("导入角色");
  if (pal.rank !== null && pal.rank > 0) labels.push(`浓缩等级 ${pal.rank}`);
  return labels;
}

export function playerInitial(value: unknown): string {
  return Array.from(textValue(value))[0]?.toLocaleUpperCase("zh-CN") || "?";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && ["true", "1"].includes(value.toLowerCase()));
}

function genderValue(value: unknown): PalTraits["gender"] {
  const normalized = textValue(value).toLowerCase();
  if (normalized.includes("female")) return "female";
  if (normalized.includes("male")) return "male";
  return null;
}
