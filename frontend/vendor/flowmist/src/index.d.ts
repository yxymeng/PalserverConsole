export type PaletteCode = 'ORIGINAL' | 'OCEAN' | 'KLEIN' | 'ULTRAVIOLET' | 'CHROME' | 'PLUS' | 'CELADON' | 'ROSE' | 'MOONSAND' | 'PINE';
export interface Palette {
  readonly code: PaletteCode; readonly name: string; readonly colors: readonly [string,string,string,string];
  readonly accentCut: number; readonly shadeStrength: number; readonly lightStrength: number;
  readonly label: string; readonly recommended: boolean;
}
export interface FlowMistOptions {
  value?: number; palette?: PaletteCode; detail?: 0 | 1; paused?: boolean; pixelRatio?: number;
  onError?: (error: Error) => void;
}
export const palettes: readonly Palette[];
export function getPalette(code?: PaletteCode): Palette;
export function normalizeOptions(options?: FlowMistOptions): Required<Omit<FlowMistOptions, 'onError'>>;
export function createFlowMist(canvas: HTMLCanvasElement, options?: FlowMistOptions): {
  update(options?: Omit<FlowMistOptions, 'onError'>): void; destroy(): void;
};
