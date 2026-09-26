import { Axe, Droplets, Fence, Flame, FlaskConical, Fuel, Hammer, Package, Pickaxe, Snowflake, Sprout, Wheat, Zap, type LucideIcon } from "lucide-react";

export const workSuitabilities: Record<string, { label: string; icon: LucideIcon }> = {
  EmitFlame: { label: "生火", icon: Flame },
  Watering: { label: "浇水", icon: Droplets },
  Seeding: { label: "播种", icon: Sprout },
  GenerateElectricity: { label: "发电", icon: Zap },
  Handcraft: { label: "手工作业", icon: Hammer },
  Collection: { label: "采集", icon: Wheat },
  Deforest: { label: "伐木", icon: Axe },
  Mining: { label: "采矿", icon: Pickaxe },
  OilExtraction: { label: "原油提炼", icon: Fuel },
  ProductMedicine: { label: "制药", icon: FlaskConical },
  Cool: { label: "冷却", icon: Snowflake },
  Transport: { label: "搬运", icon: Package },
  MonsterFarm: { label: "牧场", icon: Fence },
};
