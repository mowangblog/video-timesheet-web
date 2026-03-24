export type VideoMeta = {
  duration: number;
  width: number;
  height: number;
  name: string;
};

export type BackgroundMode = 'none' | 'color-key';

export type ExportMode = 'sheet' | 'transparent-sheet' | 'transparent-frames-zip';

export type PreviewMode = 'result' | 'mask' | 'solid';

export type KeyAlgorithm = 'enhanced' | 'classic';

export type RGBColor = {
  r: number;
  g: number;
  b: number;
};

export type CropArea = {
  leftPercent: number;
  topPercent: number;
  widthPercent: number;
  heightPercent: number;
};

export type CropBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ExtractionOptions = {
  framesPerSecond: number;
  segmentStart: number;
  segmentEnd: number;
  cropArea?: CropArea | null;
};

export type SheetOptions = {
  columns: number;
  gap: number;
  backgroundColor: string;
};

export type RenderResult = {
  blob: Blob;
  objectUrl: string;
  outputWidth: number;
  outputHeight: number;
};

export type ExtractedFrame = {
  image: HTMLCanvasElement;
  time: number;
  label: string;
};

export type ColorSample = {
  x: number;
  y: number;
  hex: string;
  rgb: RGBColor;
};

export type ColorKeyOptions = {
  sample: ColorSample;
  tolerance: number;
  softness: number;
  despill: number;
  sampleRadius: number;
  edgeRadius: number;
  smoothing: boolean;
  despillEnabled: boolean;
  algorithm: KeyAlgorithm;
};

export type ProcessedFrame = ExtractedFrame & {
  processedImage: HTMLCanvasElement;
  maskImage: HTMLCanvasElement;
};

export type LayoutMetrics = {
  rows: number;
  canvasWidth: number;
  canvasHeight: number;
  frameWidth: number;
  frameHeight: number;
  labelBlockHeight: number;
};

export type SheetAppearance = {
  transparentBackground: boolean;
  showCardBackground: boolean;
};
