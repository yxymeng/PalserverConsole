export function formatPassiveDescription(description: string | null | undefined): string {
  return description?.replace(/<Num(?:Blue|Red)_\d+>|<\/>/g, "")
    .replace(/\s*\((?:ToSelf|None)\)/g, "")
    .replace(/\{[^{}]+\}%?/g, "（数值未收录）")
    .replace(/\r\n?/g, "\n") || "";
}
