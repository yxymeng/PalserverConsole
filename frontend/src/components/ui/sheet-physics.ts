/** Height and velocity use px and px/s; upward movement increases height. */
export function rubberBand(height: number, min: number, max: number) {
  const boundary = Math.max(min, Math.min(max, height));
  const excess = height - boundary;
  return boundary + Math.sign(excess) * (1 - 1 / (Math.abs(excess) / 120 + 1)) * 48;
}

export function sheetTarget(height: number, velocity: number, compact: number, expanded: number) {
  const projected = height + Math.max(-2400, Math.min(2400, velocity)) * 0.18;
  return [0, compact, expanded].reduce((nearest, anchor) =>
    Math.abs(anchor - projected) < Math.abs(nearest - projected) ? anchor : nearest, compact);
}
