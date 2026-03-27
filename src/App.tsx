import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  CropArea,
  ColorKeyOptions,
  ColorSample,
  ExtractedFrame,
  KeyAlgorithm,
  PreviewMode,
  ProcessedFrame,
  RenderResult,
  SheetOptions,
  SpineDraft,
  SpineExportOptions,
  VideoMeta,
} from './types';
import {
  applyColorKey,
  processExtractedFrame,
  sampleCanvasColor,
} from './lib/chromaKey';
import {
  buildTransparentFramesZip,
  getBaseFileName,
  getGifFileName,
  getSheetFileName,
  getZipFileName,
} from './lib/exportBundle';
import { buildAnimatedGif } from './lib/gif';
import {
  buildSpineBundleZip,
  getSpineZipFileName,
} from './lib/spineBundle';
import {
  getLayoutMetrics,
  getSheetAppearance,
  renderFrameSheet,
} from './lib/sheet';
import { formatTimestamp } from './lib/time';
import {
  cropCanvas,
  createVideoFrameReader,
  extractFrames,
  getCropBounds,
  getSampleTimes,
  loadVideoAsset,
  normalizeCropArea,
  revokeVideoAsset,
  type VideoFrameReader,
} from './lib/video';

const DEFAULT_FRAMES_PER_SECOND = 12;
const DEFAULT_COLUMNS = 4;
const DEFAULT_GAP = 0;
const DEFAULT_KEY_ALGORITHM: KeyAlgorithm = 'enhanced';
const DEFAULT_TOLERANCE = 28;
const DEFAULT_SOFTNESS = 14;
const DEFAULT_DESPILL = 50;
const DEFAULT_EDGE_RADIUS = 22;
const DEFAULT_SAMPLE_RADIUS = 6;
const DEFAULT_SOLID_PREVIEW_BG = '#111827';
const DEFAULT_CROP_LEFT_PERCENT = 0;
const DEFAULT_CROP_TOP_PERCENT = 0;
const DEFAULT_CROP_WIDTH_PERCENT = 100;
const DEFAULT_CROP_HEIGHT_PERCENT = 100;
const MAX_EXTRACTED_FRAMES = 180;
const BRAND_ASSET_PATH = `${import.meta.env.BASE_URL}logo.jpg`;
const EXPORT_PRESETS = [
  { value: 'original', label: '原始比例', frameSize: undefined },
  { value: '32', label: '32 × 32', frameSize: 32 },
  { value: '64', label: '64 × 64', frameSize: 64 },
  { value: '128', label: '128 × 128', frameSize: 128 },
  { value: '256', label: '256 × 256', frameSize: 256 },
] as const;
const SUPPORT_LINKS = [
  {
    id: 'bilibili',
    label: 'B站',
    href: 'https://space.bilibili.com/13406042',
  },
  {
    id: 'douyin',
    label: '抖音',
    href: 'https://www.douyin.com/user/MS4wLjABAAAAycVZEUWkD8Jwx8_Mu5E4TVdR8MkFlX0xNtEhEq5mOQKHeG9m3bDt-Q_PVGkQuDAA',
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    href: 'https://www.xiaohongshu.com/user/profile/5f7310700000000001002626',
  },
] as const;

type SamplePoint = {
  x: number;
  y: number;
};

type GeneratedAssets = {
  frames: ExtractedFrame[];
  processed: ProcessedFrame[] | null;
};

type SheetPreviewResult = {
  renderResult: RenderResult;
  transparent: boolean;
};

type ResultPreviewMode = 'sheet' | 'animation';
type SpinePreviewMode = 'animation';

type SupportPlatform = (typeof SUPPORT_LINKS)[number]['id'];
type ExportPresetValue = (typeof EXPORT_PRESETS)[number]['value'];

type DragSelection = {
  start: SamplePoint;
  current: SamplePoint;
};

type SheetPreviewConfig = {
  columns: number;
  gap: number;
  frameSize: number | null;
};

function clampPercent(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function drawCanvas(
  target: HTMLCanvasElement | null,
  source: HTMLCanvasElement | null,
  marker?: SamplePoint | null,
  backgroundFill?: string,
): void {
  if (!target || !source) {
    return;
  }

  target.width = source.width;
  target.height = source.height;

  const context = target.getContext('2d');
  if (!context) {
    return;
  }

  context.clearRect(0, 0, target.width, target.height);

  if (backgroundFill) {
    context.fillStyle = backgroundFill;
    context.fillRect(0, 0, target.width, target.height);
  }

  context.drawImage(source, 0, 0);

  if (!marker) {
    return;
  }

  context.save();
  context.strokeStyle = '#ff8f1f';
  context.lineWidth = Math.max(2, source.width / 220);
  context.beginPath();
  context.arc(marker.x, marker.y, Math.max(10, source.width / 50), 0, Math.PI * 2);
  context.stroke();
  context.fillStyle = '#ff8f1f';
  context.beginPath();
  context.arc(marker.x, marker.y, Math.max(3, source.width / 130), 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function getCanvasPoint(
  event: Pick<React.PointerEvent<HTMLCanvasElement>, 'clientX' | 'clientY'>,
  canvas: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
): SamplePoint {
  const rect = canvas.getBoundingClientRect();
  const ratioX = sourceWidth / rect.width;
  const ratioY = sourceHeight / rect.height;

  return {
    x: Math.round((event.clientX - rect.left) * ratioX),
    y: Math.round((event.clientY - rect.top) * ratioY),
  };
}

function getCropAreaFromSelection(
  start: SamplePoint,
  end: SamplePoint,
  sourceWidth: number,
  sourceHeight: number,
): CropArea {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const width = Math.max(1, Math.abs(end.x - start.x));
  const height = Math.max(1, Math.abs(end.y - start.y));

  return normalizeCropArea({
    leftPercent: (left / sourceWidth) * 100,
    topPercent: (top / sourceHeight) * 100,
    widthPercent: (width / sourceWidth) * 100,
    heightPercent: (height / sourceHeight) * 100,
  });
}

function drawCropSelectionCanvas(
  target: HTMLCanvasElement | null,
  source: HTMLCanvasElement | null,
  cropArea?: CropArea | null,
): void {
  if (!target || !source) {
    return;
  }

  target.width = source.width;
  target.height = source.height;

  const context = target.getContext('2d');
  if (!context) {
    return;
  }

  context.clearRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0);

  if (!cropArea) {
    return;
  }

  const bounds = getCropBounds(source.width, source.height, cropArea);

  context.save();
  context.fillStyle = 'rgba(15, 23, 42, 0.34)';
  context.fillRect(0, 0, target.width, bounds.y);
  context.fillRect(0, bounds.y, bounds.x, bounds.height);
  context.fillRect(bounds.x + bounds.width, bounds.y, target.width - bounds.x - bounds.width, bounds.height);
  context.fillRect(0, bounds.y + bounds.height, target.width, target.height - bounds.y - bounds.height);

  context.strokeStyle = '#ff8f1f';
  context.lineWidth = Math.max(2, source.width / 220);
  context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);

  context.setLineDash([8, 8]);
  context.beginPath();
  context.moveTo(bounds.x + bounds.width / 3, bounds.y);
  context.lineTo(bounds.x + bounds.width / 3, bounds.y + bounds.height);
  context.moveTo(bounds.x + (bounds.width / 3) * 2, bounds.y);
  context.lineTo(bounds.x + (bounds.width / 3) * 2, bounds.y + bounds.height);
  context.moveTo(bounds.x, bounds.y + bounds.height / 3);
  context.lineTo(bounds.x + bounds.width, bounds.y + bounds.height / 3);
  context.moveTo(bounds.x, bounds.y + (bounds.height / 3) * 2);
  context.lineTo(bounds.x + bounds.width, bounds.y + (bounds.height / 3) * 2);
  context.stroke();
  context.restore();
}

function toTransparentSheetFrames(processedFrames: ProcessedFrame[]): ExtractedFrame[] {
  return processedFrames.map(({ processedImage, ...frame }) => ({
    ...frame,
    image: processedImage,
  }));
}

function getSheetPreviewConfigKey(config: SheetPreviewConfig): string {
  return `${config.columns}|${config.gap}|${config.frameSize ?? 'original'}`;
}

function buildSpineDraftFromAssets(
  assets: GeneratedAssets,
  baseName: string,
  width: number,
  height: number,
): SpineDraft {
  const transparent = Boolean(assets.processed);
  return {
    frames: transparent ? toTransparentSheetFrames(assets.processed ?? []) : assets.frames,
    baseName,
    width,
    height,
    transparent,
  };
}

function SupportLogo({ platform }: { platform: SupportPlatform }) {
  if (platform === 'bilibili') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4.5" y="7" width="15" height="10.5" rx="2.8" fill="none" stroke="currentColor" strokeWidth="1.9" />
        <path d="M8.4 4.5 6.8 6.7M15.6 4.5l1.6 2.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M9.2 11.1v2.2M14.8 11.1v2.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M8.5 15.3c1.1.7 2.2 1 3.5 1 1.3 0 2.4-.3 3.5-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }

  if (platform === 'douyin') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M13.2 4.5c1.2 1.8 2.6 3 4.6 3.6v2.6c-1.5-.1-2.9-.6-4-1.4v5.5a4.7 4.7 0 1 1-4.7-4.6c.4 0 .8 0 1.2.1v2.8a2 2 0 1 0 .8 1.7V4.5h2.1Z"
          fill="currentColor"
        />
        <path
          d="M11.7 4.5v10.3a2 2 0 1 1-2-2c.2 0 .5 0 .7.1v-2.8a4.8 4.8 0 1 0 4.1 4.7V9.3c1.1.8 2.5 1.3 4 1.4V8.1c-2-.6-3.4-1.8-4.6-3.6h-2.2Z"
          fill="#25F4EE"
          opacity="0.9"
        />
        <path
          d="M12.5 4.1c1.2 1.8 2.6 3 4.6 3.6v2.6c-1.5-.1-2.9-.6-4-1.4v5.5a4.7 4.7 0 1 1-4.7-4.6c.4 0 .8 0 1.2.1v2.8a2 2 0 1 0 .8 1.7V4.1h2.1Z"
          fill="#FE2C55"
          opacity="0.88"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="4.2" fill="currentColor" />
      <path
        d="M8 9.1h3.1v1.4H9.7v.8h1.2c1.5 0 2.4.8 2.4 2.1 0 1.4-1 2.3-2.6 2.3H8v-1.4h2.4c.7 0 1.1-.3 1.1-.8s-.4-.8-1.1-.8H8V9.1Zm6.6 0h1.5l-1.4 2.7 1.5 3.9h-1.6l-.8-2.2-.8 2.2h-1.5l1.5-3.9-1.4-2.7h1.5l.7 1.7.8-1.7Z"
        fill="#fff"
      />
    </svg>
  );
}

function App() {
  const currentYear = new Date().getFullYear();
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isChromaStageOpen, setIsChromaStageOpen] = useState(false);
  const [framesPerSecond, setFramesPerSecond] = useState(DEFAULT_FRAMES_PER_SECOND);
  const [segmentStart, setSegmentStart] = useState(0);
  const [segmentEnd, setSegmentEnd] = useState(0);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [gap, setGap] = useState(DEFAULT_GAP);
  const [exportPreset, setExportPreset] = useState<ExportPresetValue>('original');
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [softness, setSoftness] = useState(DEFAULT_SOFTNESS);
  const [smoothing, setSmoothing] = useState(true);
  const [despillEnabled, setDespillEnabled] = useState(true);
  const [referenceTime, setReferenceTime] = useState(0);
  const [referenceRawFrame, setReferenceRawFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceFrame, setReferenceFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceResultFrame, setReferenceResultFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceMaskFrame, setReferenceMaskFrame] = useState<HTMLCanvasElement | null>(null);
  const [cropLeftPercent, setCropLeftPercent] = useState(DEFAULT_CROP_LEFT_PERCENT);
  const [cropTopPercent, setCropTopPercent] = useState(DEFAULT_CROP_TOP_PERCENT);
  const [cropWidthPercent, setCropWidthPercent] = useState(DEFAULT_CROP_WIDTH_PERCENT);
  const [cropHeightPercent, setCropHeightPercent] = useState(DEFAULT_CROP_HEIGHT_PERCENT);
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [samplePoint, setSamplePoint] = useState<SamplePoint | null>(null);
  const [colorSample, setColorSample] = useState<ColorSample | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('result');
  const [solidPreviewColor, setSolidPreviewColor] = useState(DEFAULT_SOLID_PREVIEW_BG);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [resultTransparent, setResultTransparent] = useState(false);
  const [resultPreviewMode, setResultPreviewMode] = useState<ResultPreviewMode>('sheet');
  const [spineDraft, setSpineDraft] = useState<SpineDraft | null>(null);
  const [spineOptions, setSpineOptions] = useState<SpineExportOptions>({
    skeletonName: 'video',
    animationName: 'idle',
    slotName: 'sprite',
    fps: DEFAULT_FRAMES_PER_SECOND,
  });
  const [spineLoopPreview, setSpineLoopPreview] = useState(true);
  const spinePreviewMode: SpinePreviewMode = 'animation';
  const [spineAnimationPlaying, setSpineAnimationPlaying] = useState(true);
  const [spineAnimationFrameIndex, setSpineAnimationFrameIndex] = useState(0);
  const [animationPlaying, setAnimationPlaying] = useState(true);
  const [animationFrameIndex, setAnimationFrameIndex] = useState(0);
  const [status, setStatus] = useState('请选择一个本地视频开始生成。');
  const [isDragging, setIsDragging] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isReferenceLoading, setIsReferenceLoading] = useState(false);
  const [readerReady, setReaderReady] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [extractedFrames, setExtractedFrames] = useState<ExtractedFrame[] | null>(null);
  const [processedFrames, setProcessedFrames] = useState<ProcessedFrame[] | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const cropSelectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cropPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const referenceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const resultAnimationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const spineAnimationCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsPanelRef = useRef<HTMLDivElement | null>(null);
  const cropPanelRef = useRef<HTMLElement | null>(null);
  const chromaPanelRef = useRef<HTMLElement | null>(null);
  const chromaActionsRef = useRef<HTMLDivElement | null>(null);
  const resultPanelRef = useRef<HTMLElement | null>(null);
  const spinePanelRef = useRef<HTMLElement | null>(null);
  const readerRef = useRef<VideoFrameReader | null>(null);
  const autoPreviewTimerRef = useRef<number | null>(null);
  const autoPreviewInFlightRef = useRef(false);
  const lastSheetPreviewConfigRef = useRef<string | null>(null);
  const readerTokenRef = useRef(0);
  const pendingChromaScrollRef = useRef(false);
  const pendingChromaScrollTopRef = useRef<number | null>(null);
  const pendingResultScrollRef = useRef(false);
  const pendingResultScrollTopRef = useRef<number | null>(null);
  const pendingSpineScrollRef = useRef(false);
  const pendingSpineScrollTopRef = useRef<number | null>(null);
  const hasInitializedInvalidationRef = useRef(false);
  const latestVideoUrlRef = useRef<string | null>(null);
  const latestResultRef = useRef<RenderResult | null>(null);

  const sheetOptions: SheetOptions = {
    columns,
    gap,
    backgroundColor: '#ffffff',
    frameSize: EXPORT_PRESETS.find((preset) => preset.value === exportPreset)?.frameSize,
  };

  const baseFileName = useMemo(
    () => getBaseFileName(videoMeta?.name ?? 'video'),
    [videoMeta?.name],
  );
  const sampleTimes = useMemo(() => {
    if (!videoMeta) {
      return [];
    }

    return getSampleTimes(
      videoMeta.duration,
      framesPerSecond,
      segmentStart,
      segmentEnd,
    );
  }, [framesPerSecond, segmentEnd, segmentStart, videoMeta]);
  const firstSampleTime = sampleTimes[0] ?? 0;
  const selectedDuration = Math.max(0, segmentEnd - segmentStart);
  const estimatedFrameCount = sampleTimes.length;
  const frameLimitExceeded = estimatedFrameCount > MAX_EXTRACTED_FRAMES;
  const segmentTrackStyle = useMemo(
    () =>
      ({
        ['--segment-start' as const]: videoMeta
          ? `${(segmentStart / videoMeta.duration) * 100}%`
          : '0%',
        ['--segment-end' as const]: videoMeta
          ? `${(segmentEnd / videoMeta.duration) * 100}%`
          : '100%',
      }) as CSSProperties,
    [segmentEnd, segmentStart, videoMeta],
  );
  const cropArea = useMemo<CropArea>(
    () =>
      normalizeCropArea({
        leftPercent: cropLeftPercent,
        topPercent: cropTopPercent,
        widthPercent: cropWidthPercent,
        heightPercent: cropHeightPercent,
      }),
    [cropHeightPercent, cropLeftPercent, cropTopPercent, cropWidthPercent],
  );
  const cropBounds = useMemo(
    () =>
      videoMeta
        ? getCropBounds(videoMeta.width, videoMeta.height, cropArea)
        : null,
    [cropArea, videoMeta],
  );
  const activeCropArea = useMemo<CropArea>(
    () =>
      dragSelection && referenceRawFrame
        ? getCropAreaFromSelection(
            dragSelection.start,
            dragSelection.current,
            referenceRawFrame.width,
            referenceRawFrame.height,
          )
        : cropArea,
    [cropArea, dragSelection, referenceRawFrame],
  );
  const activeCropBounds = useMemo(
    () =>
      videoMeta
        ? getCropBounds(videoMeta.width, videoMeta.height, activeCropArea)
        : null,
    [activeCropArea, videoMeta],
  );
  const cropSurfaceStyle = useMemo<CSSProperties | undefined>(
    () =>
      videoMeta
        ? {
            aspectRatio: `${videoMeta.width} / ${videoMeta.height}`,
          }
        : undefined,
    [videoMeta],
  );
  const isCropApplied = Boolean(
    cropBounds &&
      videoMeta &&
      (cropBounds.x > 0 ||
        cropBounds.y > 0 ||
        cropBounds.width < videoMeta.width ||
        cropBounds.height < videoMeta.height),
  );
  const outputVideoMeta = useMemo<VideoMeta | null>(() => {
    if (!videoMeta || !cropBounds) {
      return videoMeta;
    }

    return {
      ...videoMeta,
      width: cropBounds.width,
      height: cropBounds.height,
    };
  }, [cropBounds, videoMeta]);
  const exportFrameSize = useMemo(
    () => EXPORT_PRESETS.find((preset) => preset.value === exportPreset)?.frameSize,
    [exportPreset],
  );
  const exportLayoutMetrics = useMemo(
    () =>
      outputVideoMeta
        ? getLayoutMetrics(
            outputVideoMeta,
            extractedFrames?.length ?? estimatedFrameCount,
            sheetOptions,
            false,
          )
        : null,
    [estimatedFrameCount, extractedFrames?.length, outputVideoMeta, sheetOptions],
  );
  const exportTargetSize = useMemo(
    () =>
      exportLayoutMetrics
        ? {
            width: exportLayoutMetrics.canvasWidth,
            height: exportLayoutMetrics.canvasHeight,
          }
        : null,
    [exportLayoutMetrics],
  );
  const sheetPreviewConfigKey = useMemo(
    () =>
      getSheetPreviewConfigKey({
        columns: sheetOptions.columns,
        gap: sheetOptions.gap,
        frameSize: sheetOptions.frameSize ?? null,
      }),
    [sheetOptions.columns, sheetOptions.frameSize, sheetOptions.gap],
  );

  const colorKeyOptions = useMemo<ColorKeyOptions | null>(() => {
    if (!colorSample) {
      return null;
    }

    return {
      sample: colorSample,
      tolerance,
      softness,
      despill: DEFAULT_DESPILL,
      sampleRadius: DEFAULT_SAMPLE_RADIUS,
      edgeRadius: DEFAULT_EDGE_RADIUS,
      smoothing,
      despillEnabled,
      algorithm: DEFAULT_KEY_ALGORITHM,
    };
  }, [
    colorSample,
    despillEnabled,
    smoothing,
    softness,
    tolerance,
  ]);

  const canGenerate = Boolean(
    videoMeta &&
      videoUrl &&
      isChromaStageOpen &&
      !isRendering &&
      estimatedFrameCount > 0 &&
      !frameLimitExceeded,
  );
  const showChromaStage = Boolean(videoMeta && isChromaStageOpen);
  const showResultStage = Boolean(result);
  const showSpineStage = Boolean(spineDraft);
  const animationFrames = useMemo<ExtractedFrame[]>(() => {
    if (processedFrames) {
      return toTransparentSheetFrames(processedFrames);
    }

    return extractedFrames ?? [];
  }, [extractedFrames, processedFrames]);
  const spineFrames = useMemo<ExtractedFrame[]>(() => spineDraft?.frames ?? [], [spineDraft]);

  function scrollToStep(target: { current: HTMLElement | null }): void {
    window.setTimeout(() => {
      target.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 180);
  }

  function replacePreviewResult(next: RenderResult | null, transparent = false): void {
    setResult((current) => {
      if (current) {
        URL.revokeObjectURL(current.objectUrl);
      }

      return next;
    });
    setResultTransparent(Boolean(next && transparent));
  }

  function disposeReferenceReader(): void {
    readerRef.current?.dispose();
    readerRef.current = null;
  }

  function clearGeneratedAssets(nextStatus?: string): void {
    pendingResultScrollRef.current = false;
    pendingResultScrollTopRef.current = null;
    pendingSpineScrollRef.current = false;
    pendingSpineScrollTopRef.current = null;
    setExtractedFrames(null);
    setProcessedFrames(null);
    replacePreviewResult(null);
    setResultPreviewMode('sheet');
    setAnimationFrameIndex(0);
    setAnimationPlaying(true);
    setSpineDraft(null);
    setSpineAnimationFrameIndex(0);
    setSpineAnimationPlaying(true);
    setSpineLoopPreview(true);
    lastSheetPreviewConfigRef.current = null;
    autoPreviewInFlightRef.current = false;
    if (autoPreviewTimerRef.current !== null) {
      window.clearTimeout(autoPreviewTimerRef.current);
      autoPreviewTimerRef.current = null;
    }
    if (nextStatus) {
      setStatus(nextStatus);
    }
  }

  useEffect(() => {
    latestVideoUrlRef.current = videoUrl;
  }, [videoUrl]);

  useEffect(() => {
    latestResultRef.current = result;
  }, [result]);

  useEffect(() => {
    return () => {
      disposeReferenceReader();
      if (autoPreviewTimerRef.current !== null) {
        window.clearTimeout(autoPreviewTimerRef.current);
      }

      if (latestVideoUrlRef.current) {
        revokeVideoAsset(latestVideoUrlRef.current);
      }

      if (latestResultRef.current) {
        URL.revokeObjectURL(latestResultRef.current.objectUrl);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (
      !pendingChromaScrollRef.current ||
      !showChromaStage ||
      pendingChromaScrollTopRef.current === null
    ) {
      return;
    }

    window.scrollTo({
      top: pendingChromaScrollTopRef.current,
      left: window.scrollX,
    });
  }, [showChromaStage]);

  useLayoutEffect(() => {
    if (
      !pendingResultScrollRef.current ||
      !showResultStage ||
      pendingResultScrollTopRef.current === null
    ) {
      return;
    }

    window.scrollTo({
      top: pendingResultScrollTopRef.current,
      left: window.scrollX,
    });
  }, [showResultStage]);

  useLayoutEffect(() => {
    if (
      !pendingSpineScrollRef.current ||
      !showSpineStage ||
      pendingSpineScrollTopRef.current === null
    ) {
      return;
    }

    window.scrollTo({
      top: pendingSpineScrollTopRef.current,
      left: window.scrollX,
    });
  }, [showSpineStage]);

  useEffect(() => {
    if (!videoUrl || !videoMeta) {
      disposeReferenceReader();
      setReferenceRawFrame(null);
      setReferenceFrame(null);
      return;
    }

    let cancelled = false;
    const token = ++readerTokenRef.current;

    setIsReferenceLoading(true);

    void createVideoFrameReader(videoUrl)
      .then((reader) => {
        if (cancelled || token !== readerTokenRef.current) {
          reader.dispose();
          return;
        }

        disposeReferenceReader();
        readerRef.current = reader;
        setReaderReady((value) => value + 1);
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : '参考帧读取失败。');
      })
      .finally(() => {
        if (!cancelled && token === readerTokenRef.current) {
          setIsReferenceLoading(false);
        }
      });

    return () => {
      cancelled = true;
      readerTokenRef.current += 1;
      disposeReferenceReader();
    };
  }, [videoMeta, videoUrl]);

  useEffect(() => {
    if (!videoMeta || !readerRef.current) {
      return;
    }

    let cancelled = false;
    const token = ++readerTokenRef.current;

    setIsReferenceLoading(true);

    void readerRef.current
      .captureFrameAt(referenceTime)
      .then((canvas) => {
        if (cancelled || token !== readerTokenRef.current) {
          return;
        }

        setReferenceRawFrame(canvas);
      })
      .catch((nextError) => {
        if (cancelled) {
          return;
        }

        setError(nextError instanceof Error ? nextError.message : '参考帧更新失败。');
      })
      .finally(() => {
        if (!cancelled && token === readerTokenRef.current) {
          setIsReferenceLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [readerReady, referenceTime, videoMeta]);

  useEffect(() => {
    if (!referenceRawFrame) {
      setReferenceFrame(null);
      return;
    }

    try {
      const cropped = cropCanvas(referenceRawFrame, cropArea);
      setReferenceFrame(cropped);
      setSamplePoint((current) => {
        if (!current) {
          return current;
        }

        if (current.x >= cropped.width || current.y >= cropped.height) {
          return null;
        }

        return current;
      });
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '参考帧裁剪失败。');
    }
  }, [cropArea, referenceRawFrame]);

  useEffect(() => {
    if (!videoMeta) {
      return;
    }

    const clampedTime = Math.min(Math.max(referenceTime, segmentStart), segmentEnd);
    if (Math.abs(clampedTime - referenceTime) > 0.001) {
      setReferenceTime(Number(clampedTime.toFixed(3)));
    }
  }, [referenceTime, segmentEnd, segmentStart, videoMeta]);

  useEffect(() => {
    if (!samplePoint && !colorSample) {
      return;
    }

    setSamplePoint(null);
    setColorSample(null);
  }, [
    cropArea.heightPercent,
    cropArea.leftPercent,
    cropArea.topPercent,
    cropArea.widthPercent,
  ]);

  useEffect(() => {
    if (!referenceFrame || !samplePoint) {
      setColorSample(null);
      return;
    }

    try {
      setColorSample(
        sampleCanvasColor(referenceFrame, samplePoint.x, samplePoint.y, DEFAULT_SAMPLE_RADIUS),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '颜色取样失败。');
    }
  }, [referenceFrame, samplePoint]);

  useEffect(() => {
    if (!referenceFrame) {
      setReferenceResultFrame(null);
      setReferenceMaskFrame(null);
      return;
    }

    if (!colorKeyOptions) {
      setReferenceResultFrame(referenceFrame);
      setReferenceMaskFrame(null);
      return;
    }

    try {
      const preview = applyColorKey(referenceFrame, colorKeyOptions);
      setReferenceResultFrame(preview.image);
      setReferenceMaskFrame(preview.mask);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '参考帧预览失败。');
    }
  }, [colorKeyOptions, referenceFrame]);

  useEffect(() => {
    drawCanvas(referenceCanvasRef.current, referenceFrame, samplePoint);
  }, [referenceFrame, samplePoint]);

  useEffect(() => {
    drawCropSelectionCanvas(cropSelectionCanvasRef.current, referenceRawFrame, activeCropArea);
  }, [activeCropArea, referenceRawFrame]);

  useEffect(() => {
    if (!referenceRawFrame) {
      return;
    }

    drawCanvas(
      cropPreviewCanvasRef.current,
      cropCanvas(referenceRawFrame, activeCropArea),
    );
  }, [activeCropArea, referenceRawFrame]);

  useEffect(() => {
    const source =
      previewMode === 'mask'
        ? referenceMaskFrame
        : referenceResultFrame ?? referenceFrame;

    drawCanvas(
      previewCanvasRef.current,
      source,
      undefined,
      previewMode === 'solid' ? solidPreviewColor : undefined,
    );
  }, [previewMode, referenceFrame, referenceMaskFrame, referenceResultFrame, solidPreviewColor]);

  useEffect(() => {
    if (
      !pendingChromaScrollRef.current ||
      !showChromaStage ||
      !referenceFrame ||
      !referenceResultFrame ||
      isReferenceLoading
    ) {
      return;
    }

    const referenceCanvas = referenceCanvasRef.current;
    const previewCanvas = previewCanvasRef.current;
    if (
      !referenceCanvas ||
      !previewCanvas ||
      referenceCanvas.width === 0 ||
      referenceCanvas.height === 0 ||
      previewCanvas.width === 0 ||
      previewCanvas.height === 0
    ) {
      return;
    }

    let nextFrameId = 0;
    let finalFrameId = 0;

    nextFrameId = window.requestAnimationFrame(() => {
      finalFrameId = window.requestAnimationFrame(() => {
        pendingChromaScrollRef.current = false;
        pendingChromaScrollTopRef.current = null;
        scrollToStep(chromaPanelRef);
      });
    });

    return () => {
      window.cancelAnimationFrame(nextFrameId);
      window.cancelAnimationFrame(finalFrameId);
    };
  }, [isReferenceLoading, referenceFrame, referenceResultFrame, showChromaStage]);

  useEffect(() => {
    if (
      !pendingResultScrollRef.current ||
      !showResultStage ||
      !result ||
      resultPreviewMode !== 'sheet'
    ) {
      return;
    }

    let nextFrameId = 0;
    let finalFrameId = 0;

    nextFrameId = window.requestAnimationFrame(() => {
      finalFrameId = window.requestAnimationFrame(() => {
        pendingResultScrollRef.current = false;
        pendingResultScrollTopRef.current = null;
        scrollToStep(resultPanelRef);
      });
    });

    return () => {
      window.cancelAnimationFrame(nextFrameId);
      window.cancelAnimationFrame(finalFrameId);
    };
  }, [result, resultPreviewMode, showResultStage]);

  useEffect(() => {
    if (!spineFrames.length) {
      setSpineAnimationFrameIndex(0);
      return;
    }

    setSpineAnimationFrameIndex((current) => Math.min(current, spineFrames.length - 1));
  }, [spineFrames.length]);

  useEffect(() => {
    const frame = spineFrames[spineAnimationFrameIndex];
    if (!frame) {
      return;
    }

    drawCanvas(spineAnimationCanvasRef.current, frame.image);
  }, [spineAnimationFrameIndex, spineFrames]);

  useEffect(() => {
    if (
      !pendingSpineScrollRef.current ||
      !showSpineStage ||
      !spineDraft ||
      spinePreviewMode !== 'animation' ||
      !spineFrames.length
    ) {
      return;
    }

    const canvas = spineAnimationCanvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      return;
    }

    let nextFrameId = 0;
    let finalFrameId = 0;

    nextFrameId = window.requestAnimationFrame(() => {
      finalFrameId = window.requestAnimationFrame(() => {
        pendingSpineScrollRef.current = false;
        pendingSpineScrollTopRef.current = null;
        scrollToStep(spinePanelRef);
      });
    });

    return () => {
      window.cancelAnimationFrame(nextFrameId);
      window.cancelAnimationFrame(finalFrameId);
    };
  }, [showSpineStage, spineDraft, spineFrames, spinePreviewMode]);

  useEffect(() => {
    if (!animationFrames.length) {
      setAnimationFrameIndex(0);
      return;
    }

    setAnimationFrameIndex((current) => Math.min(current, animationFrames.length - 1));
  }, [animationFrames.length]);

  useEffect(() => {
    const frame = animationFrames[animationFrameIndex];
    if (!frame) {
      return;
    }

    drawCanvas(resultAnimationCanvasRef.current, frame.image);
  }, [animationFrameIndex, animationFrames]);

  useEffect(() => {
    if (
      !animationPlaying ||
      resultPreviewMode !== 'animation' ||
      animationFrames.length <= 1
    ) {
      return;
    }

    const playbackFps = Math.min(Math.max(framesPerSecond, 1), 24);
    const interval = window.setInterval(() => {
      setAnimationFrameIndex((current) => (current + 1) % animationFrames.length);
    }, Math.round(1000 / playbackFps));

    return () => {
      window.clearInterval(interval);
    };
  }, [animationFrames.length, animationPlaying, framesPerSecond, resultPreviewMode]);

  useEffect(() => {
    if (
      !spineAnimationPlaying ||
      spinePreviewMode !== 'animation' ||
      spineFrames.length <= 1
    ) {
      return;
    }

    const playbackFps = Math.min(Math.max(spineOptions.fps, 1), 60);
    const interval = window.setInterval(() => {
      setSpineAnimationFrameIndex((current) => {
        if (spineLoopPreview) {
          return (current + 1) % spineFrames.length;
        }

        if (current >= spineFrames.length - 1) {
          window.clearInterval(interval);
          setSpineAnimationPlaying(false);
          return current;
        }

        return current + 1;
      });
    }, Math.round(1000 / playbackFps));

    return () => {
      window.clearInterval(interval);
    };
  }, [spineAnimationPlaying, spineFrames.length, spineLoopPreview, spineOptions.fps, spinePreviewMode]);

  useEffect(() => {
    if (!showResultStage || autoPreviewInFlightRef.current) {
      return;
    }

    if (lastSheetPreviewConfigRef.current === null || lastSheetPreviewConfigRef.current === sheetPreviewConfigKey) {
      return;
    }

    if (autoPreviewTimerRef.current !== null) {
      window.clearTimeout(autoPreviewTimerRef.current);
    }

    autoPreviewTimerRef.current = window.setTimeout(() => {
      autoPreviewTimerRef.current = null;
      autoPreviewInFlightRef.current = true;
      setError(null);
      setStatus('参数已更新，正在自动刷新序列图...');
      void renderSheetPreview()
        .catch((nextError) => {
          setError(nextError instanceof Error ? nextError.message : '自动预览失败。');
          setStatus('自动预览失败，请稍后重试。');
        })
        .finally(() => {
          autoPreviewInFlightRef.current = false;
        });
    }, 220);

    return () => {
      if (autoPreviewTimerRef.current !== null) {
        window.clearTimeout(autoPreviewTimerRef.current);
        autoPreviewTimerRef.current = null;
      }
    };
  }, [sheetPreviewConfigKey, showResultStage]);

  useEffect(() => {
    if (!hasInitializedInvalidationRef.current) {
      hasInitializedInvalidationRef.current = true;
      return;
    }

    if (!extractedFrames && !processedFrames && !result) {
      return;
    }

    clearGeneratedAssets('参数已更新，请重新生成最新结果。');
  }, [
    colorSample?.hex,
    cropArea.heightPercent,
    cropArea.leftPercent,
    cropArea.topPercent,
    cropArea.widthPercent,
    despillEnabled,
    framesPerSecond,
    samplePoint?.x,
    samplePoint?.y,
    segmentEnd,
    segmentStart,
    smoothing,
    softness,
    tolerance,
    videoUrl,
  ]);

  async function updateFile(file: File): Promise<void> {
    setError(null);
    setStatus('正在读取视频元数据...');

    disposeReferenceReader();
    setReferenceRawFrame(null);
    setReferenceFrame(null);
    setReferenceResultFrame(null);
    setReferenceMaskFrame(null);
    setCropLeftPercent(DEFAULT_CROP_LEFT_PERCENT);
    setCropTopPercent(DEFAULT_CROP_TOP_PERCENT);
    setCropWidthPercent(DEFAULT_CROP_WIDTH_PERCENT);
    setCropHeightPercent(DEFAULT_CROP_HEIGHT_PERCENT);
    setSamplePoint(null);
    setColorSample(null);
    setIsChromaStageOpen(false);
    pendingChromaScrollRef.current = false;
    pendingChromaScrollTopRef.current = null;
    pendingResultScrollRef.current = false;
    pendingResultScrollTopRef.current = null;
    clearGeneratedAssets();

    if (videoUrl) {
      revokeVideoAsset(videoUrl);
      setVideoUrl(null);
    }

    try {
      const asset = await loadVideoAsset(file);
      setVideoMeta(asset.meta);
      setVideoUrl(asset.url);
      setSegmentStart(0);
      setSegmentEnd(Number(asset.meta.duration.toFixed(3)));
      setReferenceTime(0);
      setPreviewMode('result');
      setStatus('视频已就绪，请先裁剪画面，再设置片段并提取参考帧。');
      scrollToStep(cropPanelRef);
    } catch (nextError) {
      setVideoMeta(null);
      setStatus('读取失败，请换一个文件后重试。');
      setError(nextError instanceof Error ? nextError.message : '读取视频失败。');
    }
  }

  function handleDrop(fileList: FileList | null): void {
    const file = fileList?.[0];
    if (!file) {
      return;
    }

    void updateFile(file);
  }

  async function generateAssets(): Promise<GeneratedAssets> {
    if (!videoMeta || !videoUrl) {
      throw new Error('请先上传一个视频文件。');
    }

    if (frameLimitExceeded) {
      throw new Error(`当前片段预计会提取 ${estimatedFrameCount} 帧，请缩短片段或降低每秒帧数。`);
    }

    setError(null);
    setIsRendering(true);

    try {
      setStatus(`正在抽取序列帧 0/${estimatedFrameCount}...`);
      const frames = await extractFrames(
        videoUrl,
        videoMeta,
        {
          framesPerSecond,
          segmentStart,
          segmentEnd,
          cropArea,
        },
        (current, total) => {
          setStatus(`正在抽取序列帧 ${current}/${total}...`);
        },
      );

      if (!colorKeyOptions) {
        setExtractedFrames(frames);
        setProcessedFrames(null);

        return {
          frames,
          processed: null,
        };
      }

      const nextProcessedFrames: ProcessedFrame[] = [];

      for (const [index, frame] of frames.entries()) {
        setStatus(`正在执行 ChromaKey 抠像 ${index + 1}/${frames.length}...`);
        nextProcessedFrames.push(processExtractedFrame(frame, colorKeyOptions));
        if (index < frames.length - 1) {
          await nextFrame();
        }
      }

      setExtractedFrames(frames);
      setProcessedFrames(nextProcessedFrames);

      return {
        frames,
        processed: nextProcessedFrames,
      };
    } finally {
      setIsRendering(false);
    }
  }

  async function ensureAssets(): Promise<GeneratedAssets> {
    if (extractedFrames) {
      return {
        frames: extractedFrames,
        processed: processedFrames,
      };
    }

    return generateAssets();
  }

  async function renderSheetPreview(assets?: GeneratedAssets): Promise<SheetPreviewResult> {
    if (!outputVideoMeta) {
      throw new Error('请先上传视频。');
    }

    const currentAssets = assets ?? (await ensureAssets());
    const transparent = Boolean(currentAssets.processed);
    const framesForRender = currentAssets.processed
      ? toTransparentSheetFrames(currentAssets.processed)
      : currentAssets.frames;

    setStatus(transparent ? '正在拼接透明序列表...' : '正在拼接序列图...');
    const renderResult = await renderFrameSheet(
      framesForRender,
      outputVideoMeta,
      sheetOptions,
      false,
      getSheetAppearance(transparent),
    );

    replacePreviewResult(renderResult, transparent);
    lastSheetPreviewConfigRef.current = sheetPreviewConfigKey;
    setStatus(transparent ? '透明序列图已生成，可以继续预览或下载。' : '普通序列图已生成，可以继续预览或下载。');

    return {
      renderResult,
      transparent,
    };
  }

  async function handleGeneratePreview(): Promise<void> {
    try {
      pendingResultScrollTopRef.current = window.scrollY;
      pendingResultScrollRef.current = true;
      const assets = await ensureAssets();
      await renderSheetPreview(assets);
    } catch (nextError) {
      pendingResultScrollRef.current = false;
      pendingResultScrollTopRef.current = null;
      setError(nextError instanceof Error ? nextError.message : '生成失败。');
      setStatus('生成失败，请调整参数后重试。');
    }
  }

  async function handleDownloadSheet(): Promise<void> {
    try {
      const preview = await renderSheetPreview();
      triggerBlobDownload(
        preview.renderResult.blob,
        getSheetFileName(baseFileName, preview.transparent),
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '导出失败。');
      setStatus('导出失败，请稍后再试。');
    }
  }

  async function handleDownloadZip(): Promise<void> {
    try {
      const assets = await ensureAssets();
      if (!assets.processed) {
        throw new Error('透明帧 ZIP 需要先启用背景扣像并完成取色。');
      }

      setError(null);
      setIsRendering(true);
      setStatus('正在打包透明 PNG ZIP...');
      const blob = await buildTransparentFramesZip(assets.processed, baseFileName);
      triggerBlobDownload(blob, getZipFileName(baseFileName));
      setStatus('透明 PNG ZIP 已生成并开始下载。');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '打包 ZIP 失败。');
      setStatus('ZIP 导出失败，请稍后再试。');
    } finally {
      setIsRendering(false);
    }
  }

  async function handleDownloadGif(): Promise<void> {
    try {
      const assets = await ensureAssets();
      const transparent = Boolean(assets.processed);
      const framesForGif = transparent
        ? toTransparentSheetFrames(assets.processed ?? [])
        : assets.frames;

      if (!framesForGif.length) {
        throw new Error('没有可导出的序列帧，请先生成预览。');
      }

      setError(null);
      setIsRendering(true);
      setStatus('正在分析 GIF 调色板...');

      const blob = await buildAnimatedGif(framesForGif, {
        fps: framesPerSecond,
        transparent,
        onProgress: (progress) => {
          if (progress.phase === 'palette') {
            setStatus(`正在分析 GIF 调色板 ${progress.current}/${progress.total}...`);
            return;
          }

          setStatus(`正在编码 GIF ${progress.current}/${progress.total}...`);
        },
      });

      triggerBlobDownload(blob, getGifFileName(baseFileName, transparent));
      setStatus('GIF 已生成并开始下载。');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'GIF 导出失败。');
      setStatus('GIF 导出失败，请稍后再试。');
    } finally {
      setIsRendering(false);
    }
  }

  async function handleOpenSpineWorkspace(): Promise<void> {
    try {
      if (!outputVideoMeta) {
        throw new Error('请先上传视频并生成可用帧数据。');
      }

      setError(null);
      const assets = await ensureAssets();
      const nextDraft = buildSpineDraftFromAssets(
        assets,
        baseFileName,
        outputVideoMeta.width,
        outputVideoMeta.height,
      );

      pendingSpineScrollTopRef.current = window.scrollY;
      pendingSpineScrollRef.current = true;
      setSpineDraft(nextDraft);
      setSpineOptions({
        skeletonName: baseFileName,
        animationName: 'idle',
        slotName: 'sprite',
        fps: framesPerSecond,
      });
      setSpineLoopPreview(true);
      setSpineAnimationFrameIndex(0);
      setSpineAnimationPlaying(true);
      setStatus('Spine 动画工作区已准备好，可以继续预览或下载 Spine ZIP。');
    } catch (nextError) {
      pendingSpineScrollRef.current = false;
      pendingSpineScrollTopRef.current = null;
      setError(nextError instanceof Error ? nextError.message : '打开 Spine 工作区失败。');
      setStatus('Spine 工作区打开失败，请稍后重试。');
    }
  }

  async function handleDownloadSpineZip(): Promise<void> {
    try {
      if (!spineDraft) {
        throw new Error('请先进入 Spine 动画工作区。');
      }

      setError(null);
      setIsRendering(true);
      setStatus('正在打包 Spine JSON + PNG ZIP...');
      const blob = await buildSpineBundleZip(spineDraft, spineOptions);
      triggerBlobDownload(blob, getSpineZipFileName(spineDraft.baseName));
      setStatus('Spine ZIP 已生成并开始下载。');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Spine 导出失败。');
      setStatus('Spine ZIP 导出失败，请稍后再试。');
    } finally {
      setIsRendering(false);
    }
  }

  function resetCropArea(): void {
    setDragSelection(null);
    setCropLeftPercent(DEFAULT_CROP_LEFT_PERCENT);
    setCropTopPercent(DEFAULT_CROP_TOP_PERCENT);
    setCropWidthPercent(DEFAULT_CROP_WIDTH_PERCENT);
    setCropHeightPercent(DEFAULT_CROP_HEIGHT_PERCENT);
  }

  function applyCropArea(nextCropArea: CropArea): void {
    const normalized = normalizeCropArea(nextCropArea);
    setCropLeftPercent(normalized.leftPercent);
    setCropTopPercent(normalized.topPercent);
    setCropWidthPercent(normalized.widthPercent);
    setCropHeightPercent(normalized.heightPercent);
  }

  function handleCropLeftChange(value: number): void {
    setDragSelection(null);
    const nextLeft = clampPercent(value, 0, 99);
    setCropLeftPercent(nextLeft);
    setCropWidthPercent((current) => clampPercent(current, 1, 100 - nextLeft));
  }

  function handleCropTopChange(value: number): void {
    setDragSelection(null);
    const nextTop = clampPercent(value, 0, 99);
    setCropTopPercent(nextTop);
    setCropHeightPercent((current) => clampPercent(current, 1, 100 - nextTop));
  }

  function handleCropWidthChange(value: number): void {
    setDragSelection(null);
    setCropWidthPercent(clampPercent(value, 1, 100 - cropLeftPercent));
  }

  function handleCropHeightChange(value: number): void {
    setDragSelection(null);
    setCropHeightPercent(clampPercent(value, 1, 100 - cropTopPercent));
  }

  function handleCropPointerDown(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceRawFrame) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceRawFrame.width,
      referenceRawFrame.height,
    );
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragSelection({
      start: point,
      current: point,
    });
  }

  function handleCropPointerMove(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceRawFrame || !dragSelection) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceRawFrame.width,
      referenceRawFrame.height,
    );
    setDragSelection((current) =>
      current
        ? {
            ...current,
            current: point,
          }
        : current,
    );
  }

  function finishCropSelection(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (!referenceRawFrame || !dragSelection) {
      return;
    }

    const point = getCanvasPoint(
      event,
      event.currentTarget,
      referenceRawFrame.width,
      referenceRawFrame.height,
    );
    const selectionWidth = Math.abs(point.x - dragSelection.start.x);
    const selectionHeight = Math.abs(point.y - dragSelection.start.y);

    event.currentTarget.releasePointerCapture(event.pointerId);

    if (selectionWidth < 8 || selectionHeight < 8) {
      setDragSelection(null);
      setStatus('框选区域过小，请重新拖拽鼠标选择裁剪范围。');
      return;
    }

    applyCropArea(
      getCropAreaFromSelection(
        dragSelection.start,
        point,
        referenceRawFrame.width,
        referenceRawFrame.height,
      ),
    );
    setDragSelection(null);
    setStatus('裁剪区域已更新，下一步请设置片段并提取参考帧。');
    scrollToStep(controlsPanelRef);
  }

  function handleCropPointerCancel(event: React.PointerEvent<HTMLCanvasElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setDragSelection(null);
  }

  function handleReferenceCanvasClick(event: React.MouseEvent<HTMLCanvasElement>): void {
    if (!referenceFrame || !referenceCanvasRef.current) {
      return;
    }

    const rect = referenceCanvasRef.current.getBoundingClientRect();
    const ratioX = referenceFrame.width / rect.width;
    const ratioY = referenceFrame.height / rect.height;
    const x = Math.round((event.clientX - rect.left) * ratioX);
    const y = Math.round((event.clientY - rect.top) * ratioY);

    setSamplePoint({
      x,
      y,
    });
    setStatus('背景颜色已采样，可以继续调整容差、羽化和去溢色。');
    if (!samplePoint) {
      scrollToStep(chromaActionsRef);
    }
  }

  return (
    <div className="page-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />

      <main className="app-card">
        <section className="hero">
          {/* <div className="hero-brand">
            <img
              className="hero-brand__avatar"
              src={BRAND_ASSET_PATH}
              alt="mowangblog 官方防伪标识"
            />
            <div className="hero-brand__info">
              <p className="eyebrow">今天又被Godot打了</p>
              
            </div>
          </div> */}
          <h1 className="hero-title">
            <span className="hero-title__main">视频转序列帧表</span>
            <span className="hero-title__version">2.0</span>
          </h1>
          <div className="hero-support-row">
            <p className="hero-copy">永久免费工具，欢迎一键三连➕关注支持更新。</p>
            <div className="hero-links">
              {SUPPORT_LINKS.map((link) => (
                <a
                  key={link.label}
                  className={`hero-link hero-link--${link.id}`}
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="hero-link__icon" aria-hidden="true">
                    <SupportLogo platform={link.id} />
                  </span>
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        </section>

        <div className="status-banner status-banner--global">{status}</div>

        <section className="workspace-grid workspace-grid--single">
          <div className="panel upload-panel">
            <div className="panel-head">
              <h2>1. 上传视频</h2>
            </div>

            <input
              ref={inputRef}
              hidden
              accept="video/*"
              type="file"
              onChange={(event) => {
                handleDrop(event.target.files);
                event.currentTarget.value = '';
              }}
            />

            <div className={`upload-layout ${videoUrl ? 'upload-layout--with-preview' : ''}`}>
              <button
                className={`dropzone ${isDragging ? 'is-dragging' : ''}`}
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  handleDrop(event.dataTransfer.files);
                }}
              >
                <span className="dropzone-kicker">拖放视频到这里</span>
                <strong>或点击选择本地文件</strong>
                <small>推荐使用单色背景视频。纯前端处理时，长视频会消耗更多浏览器内存。</small>
              </button>

              {videoUrl ? (
                <div className="video-preview-card">
                  <span>视频预览</span>
                  <video className="upload-video-preview" controls muted playsInline src={videoUrl} />
                </div>
              ) : null}
            </div>

          </div>
        </section>

        {videoMeta ? (
          <section ref={cropPanelRef} className="crop-row">
            <div className="crop-picker crop-picker--row">
              <div className="crop-preview-grid">
                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>鼠标框选裁剪</span>
                      <small>在参考画面上拖拽，直接选择要保留的区域</small>
                    </div>
                  </div>
                  <div className="canvas-surface crop-canvas-surface" style={cropSurfaceStyle}>
                    {referenceRawFrame ? (
                      <canvas
                        ref={cropSelectionCanvasRef}
                        className="preview-canvas crop-preview-canvas crop-selection-canvas"
                        onPointerCancel={handleCropPointerCancel}
                        onPointerDown={handleCropPointerDown}
                        onPointerMove={handleCropPointerMove}
                        onPointerUp={finishCropSelection}
                      />
                    ) : (
                      <div className="crop-placeholder">视频读取后可直接鼠标框选裁剪区域</div>
                    )}
                  </div>
                  <div className="canvas-footer">
                    <span>也可以继续用下面的数值输入精确微调</span>
                  </div>
                </div>

                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>裁剪预览</span>
                      <small>这里会实时显示当前裁剪后的输出画面</small>
                    </div>
                  </div>
                  <div className="canvas-surface crop-canvas-surface" style={cropSurfaceStyle}>
                    {referenceRawFrame ? (
                      <canvas
                        ref={cropPreviewCanvasRef}
                        className="preview-canvas crop-preview-canvas"
                      />
                    ) : (
                      <div className="crop-placeholder">视频读取后，这里会显示裁剪预览</div>
                    )}
                  </div>
                  <div className="canvas-footer">
                    <span>
                      当前输出尺寸：{activeCropBounds?.width ?? videoMeta.width} ×{' '}
                      {activeCropBounds?.height ?? videoMeta.height}
                    </span>
                  </div>
                </div>
              </div>

              <div className="crop-controls-grid">
                <div className="crop-controls-pane">
                  <div className="crop-controls-head">
                    <strong>2. 画面裁剪</strong>
                    <span>
                      当前输出尺寸：{activeCropBounds?.width ?? videoMeta.width} ×{' '}
                      {activeCropBounds?.height ?? videoMeta.height}
                    </span>
                  </div>

                  <div className="crop-controls-head">
                    <strong>裁剪微调</strong>
                    <span>继续用数值做精确裁剪</span>
                  </div>

                  <div className="crop-grid">
                    <label className="field">
                      <span>左侧偏移 (%)</span>
                      <input
                        min={0}
                        max={99}
                        type="number"
                        value={cropLeftPercent}
                        onChange={(event) => handleCropLeftChange(Number(event.target.value) || 0)}
                      />
                    </label>

                    <label className="field">
                      <span>顶部偏移 (%)</span>
                      <input
                        min={0}
                        max={99}
                        type="number"
                        value={cropTopPercent}
                        onChange={(event) => handleCropTopChange(Number(event.target.value) || 0)}
                      />
                    </label>

                    <label className="field">
                      <span>裁剪宽度 (%)</span>
                      <input
                        min={1}
                        max={100 - cropLeftPercent}
                        type="number"
                        value={cropWidthPercent}
                        onChange={(event) => handleCropWidthChange(Number(event.target.value) || 1)}
                      />
                    </label>

                    <label className="field">
                      <span>裁剪高度 (%)</span>
                      <input
                        min={1}
                        max={100 - cropTopPercent}
                        type="number"
                        value={cropHeightPercent}
                        onChange={(event) => handleCropHeightChange(Number(event.target.value) || 1)}
                      />
                    </label>
                  </div>

                  <div className="crop-picker__footer">
                    <small>
                      你可以直接鼠标框选，也可以继续用百分比数值精确裁剪。
                    </small>
                    <button
                      className="ghost-button"
                      disabled={!isCropApplied}
                      type="button"
                      onClick={resetCropArea}
                    >
                      重置裁剪
                    </button>
                  </div>
                </div>

                <div ref={controlsPanelRef} className="controls-pane">
                  <div className="crop-controls-head">
                    <strong>3. 提取帧</strong>
                    <span>先确认片段和每秒帧数，再提取参考帧开始取色。</span>
                  </div>

                  <div className="control-grid">
                    <label className="field field-card">
                      <span>每秒提取帧数</span>
                      <input
                        min={1}
                        max={24}
                        type="number"
                        value={framesPerSecond}
                        onChange={(event) => setFramesPerSecond(Number(event.target.value) || 1)}
                      />
                    </label>

                    <div className="option-card option-card--metric">
                      <span>预计结果</span>
                      <strong>{estimatedFrameCount} 帧</strong>
                      <small>{selectedDuration.toFixed(2)} 秒片段</small>
                    </div>
                  </div>

                  <div className="segment-picker">
                    <div className="segment-picker__head">
                      <span>视频片段</span>
                      <strong>{formatTimestamp(segmentStart)} - {formatTimestamp(segmentEnd)}</strong>
                    </div>

                    <div className="segment-slider" style={segmentTrackStyle}>
                      <div className="segment-slider__track" />
                      <div className="segment-slider__active" />
                      <input
                        aria-label="开始位置"
                        className="segment-slider__input segment-slider__input--start"
                        max={videoMeta.duration}
                        min={0}
                        step={0.01}
                        type="range"
                        value={segmentStart}
                        onChange={(event) => {
                          const nextStart = Math.min(Number(event.target.value), segmentEnd);
                          setSegmentStart(Number(nextStart.toFixed(3)));
                        }}
                      />
                      <input
                        aria-label="结束位置"
                        className="segment-slider__input segment-slider__input--end"
                        max={videoMeta.duration}
                        min={0}
                        step={0.01}
                        type="range"
                        value={segmentEnd}
                        onChange={(event) => {
                          const nextEnd = Math.max(Number(event.target.value), segmentStart);
                          setSegmentEnd(Number(nextEnd.toFixed(3)));
                        }}
                      />
                    </div>

                    <div className="segment-picker__meta">
                      <div className="segment-pill">
                        <span>开始</span>
                        <strong>{formatTimestamp(segmentStart)}</strong>
                      </div>
                      <div className="segment-pill">
                        <span>结束</span>
                        <strong>{formatTimestamp(segmentEnd)}</strong>
                      </div>
                      <div className="segment-pill">
                        <span>片段长度</span>
                        <strong>{selectedDuration.toFixed(2)} 秒</strong>
                      </div>
                    </div>
                  </div>

                  <button
                    className="primary-button"
                    type="button"
                      onClick={() => {
                        pendingChromaScrollTopRef.current = window.scrollY;
                        setReferenceTime(firstSampleTime);
                        setIsChromaStageOpen(true);
                        pendingChromaScrollRef.current = true;
                        setStatus('已提取片段中的第一张参考帧，可直接生成序列图，或先点背景颜色再做抠图。');
                      }}
                  >
                    {isChromaStageOpen ? '重新提取参考帧' : '提取帧'}
                  </button>

                  {frameLimitExceeded ? (
                    <p className="error-text">当前设置预计提取 {estimatedFrameCount} 帧，建议缩短片段或降低每秒帧数。</p>
                  ) : null}
                  {error ? <p className="error-text">{error}</p> : null}
                </div>
              </div>
            </div>
          </section>
        ) : null}

        {showChromaStage ? (
        <section ref={chromaPanelRef} className="panel chroma-panel">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>4. 参考帧与抠像预览</h2>
              <span>直接在左侧预览图里点击背景颜色；右侧可切换结果、蒙版和纯色底检查。</span>
            </div>
          </div>

          <>
              <div className="reference-toolbar">
                <label className="range-block">
                  <span>参考帧时间</span>
                  <input
                    max={segmentEnd}
                    min={segmentStart}
                    step={0.01}
                    type="range"
                    value={referenceTime}
                    onChange={(event) => setReferenceTime(Number(event.target.value))}
                  />
                </label>

                <div className="reference-meta">
                  <strong>{videoMeta ? formatTimestamp(referenceTime) : '00:00.000'}</strong>
                  <span>{isReferenceLoading ? '参考帧更新中...' : `${formatTimestamp(segmentStart)} - ${formatTimestamp(segmentEnd)} 片段内取色`}</span>
                </div>
              </div>

              <div className="sample-badge-row">
                <div className="sample-badge">
                  <span
                    className="sample-swatch"
                    style={{ backgroundColor: colorSample?.hex ?? '#e6e8f3' }}
                  />
                  <div>
                    <strong>
                      {colorSample
                        ? `RGB(${colorSample.rgb.r}, ${colorSample.rgb.g}, ${colorSample.rgb.b})`
                        : '未选择背景颜色'}
                    </strong>
                    <span>
                      {samplePoint
                        ? `位置: (${samplePoint.x}, ${samplePoint.y})`
                        : '可直接生成普通序列图，或点击左侧预览图取背景色'}
                    </span>
                  </div>
                </div>

                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => {
                    setSamplePoint(null);
                    setColorSample(null);
                  }}
                >
                  清除颜色
                </button>
              </div>

              <div className="reference-grid">
                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>原图</span>
                      <small>{samplePoint ? '已选背景点，可继续点击更换' : '点击背景取样'}</small>
                    </div>
                  </div>
                  <div className="canvas-surface">
                    <canvas
                      ref={referenceCanvasRef}
                      className="preview-canvas"
                      onClick={handleReferenceCanvasClick}
                    />
                  </div>
                  <div className="canvas-footer">
                    <span>{samplePoint ? `当前取样点：(${samplePoint.x}, ${samplePoint.y})` : '点击原图任意背景区域开始取色'}</span>
                  </div>
                </div>

                <div className="canvas-card">
                  <div className="canvas-head">
                    <div className="canvas-title">
                      <span>抠图预览结果</span>
                      <small>切换模式检查边缘干净度</small>
                    </div>
                    <div className="segmented-control">
                      <button
                        className={`segmented-button ${previewMode === 'result' ? 'is-active' : ''}`}
                        type="button"
                        onClick={() => setPreviewMode('result')}
                      >
                        抠像结果
                      </button>
                      <button
                        className={`segmented-button ${previewMode === 'mask' ? 'is-active' : ''}`}
                        disabled={!referenceMaskFrame}
                        type="button"
                        onClick={() => setPreviewMode('mask')}
                      >
                        Alpha 蒙版
                      </button>
                      <button
                        className={`segmented-button ${previewMode === 'solid' ? 'is-active' : ''}`}
                        disabled={!referenceResultFrame}
                        type="button"
                        onClick={() => setPreviewMode('solid')}
                      >
                        纯色底
                      </button>
                    </div>
                  </div>
                  <div className="canvas-surface checkerboard">
                    <canvas ref={previewCanvasRef} className="preview-canvas" />
                  </div>
                  <div className="solid-preview-bar">
                    <span>纯色底检查色</span>
                    <div className="color-field color-field--compact">
                      <input
                        type="color"
                        value={solidPreviewColor}
                        onChange={(event) => setSolidPreviewColor(event.target.value)}
                      />
                      <code>{solidPreviewColor}</code>
                    </div>
                  </div>
                </div>
              </div>

              <div className="advanced-panel">
                <div className="advanced-head">
                  <h3>高级参数设置</h3>
                  <span>容差、羽化、边缘平滑、去溢色都会即时影响右侧预览。</span>
                </div>

                <div className="advanced-grid">
                  <label className="range-field">
                    <span>颜色容差: {tolerance}</span>
                    <input
                      max={120}
                      min={0}
                      type="range"
                      value={tolerance}
                      onChange={(event) => setTolerance(Number(event.target.value))}
                    />
                    <small>越大越容易把接近背景色的区域一起抠除。</small>
                  </label>

                  <label className="range-field">
                    <span>羽化半径: {softness}px</span>
                    <input
                      max={60}
                      min={0}
                      type="range"
                      value={softness}
                      onChange={(event) => setSoftness(Number(event.target.value))}
                    />
                    <small>控制边缘从透明到不透明的过渡长度。</small>
                  </label>

                  <div className="toggle-group">
                    <label className="toggle-card">
                      <input
                        checked={smoothing}
                        type="checkbox"
                        onChange={(event) => setSmoothing(event.target.checked)}
                      />
                      <span>边缘平滑</span>
                    </label>

                    <label className="toggle-card">
                      <input
                        checked={despillEnabled}
                        type="checkbox"
                        onChange={(event) => setDespillEnabled(event.target.checked)}
                      />
                      <span>溢色移除</span>
                    </label>
                  </div>
                </div>
              </div>

              <div ref={chromaActionsRef} className="chroma-actions">
                <button
                  className="primary-button chroma-generate-button"
                  disabled={!canGenerate}
                  type="button"
                  onClick={() => void handleGeneratePreview()}
                >
                  {isRendering ? '正在生成序列图...' : '4. 生成序列图'}
                </button>
              </div>
          </>
        </section>
        ) : null}

        {showResultStage ? (
        <section ref={resultPanelRef} className="result-grid">
          <div className="panel preview-panel">
            <div className="panel-head">
              <h2>5. 序列图预览</h2>
              <span>
                {result
                  ? `${resultTransparent ? '透明序列图' : '普通序列图'} · ${result.outputWidth} × ${result.outputHeight}`
                  : '等待生成'}
              </span>
            </div>

            <div className="segmented-control segmented-control--result">
              <button
                className={`segmented-button ${resultPreviewMode === 'sheet' ? 'is-active' : ''}`}
                type="button"
                onClick={() => setResultPreviewMode('sheet')}
              >
                序列图
              </button>
              <button
                className={`segmented-button ${resultPreviewMode === 'animation' ? 'is-active' : ''}`}
                disabled={!animationFrames.length}
                type="button"
                onClick={() => setResultPreviewMode('animation')}
              >
                动画预览
              </button>
            </div>

            {result && resultPreviewMode === 'sheet' ? (
              <div className="preview-wrap">
                <img alt="生成的序列帧表预览" className="preview-image" src={result.objectUrl} />
              </div>
            ) : result && resultPreviewMode === 'animation' ? (
              <>
                <div
                  className={`preview-wrap preview-wrap--animation ${
                    resultTransparent ? 'preview-wrap--transparent' : 'preview-wrap--solid'
                  }`}
                >
                  <canvas
                    ref={resultAnimationCanvasRef}
                    aria-label="序列帧动画预览"
                    className="preview-canvas"
                  />
                </div>

                <div className="animation-toolbar">
                  <div className="animation-meta">
                    <strong>
                      第 {Math.min(animationFrameIndex + 1, animationFrames.length)} / {animationFrames.length} 帧
                    </strong>
                    <span>
                      {animationFrames[animationFrameIndex]
                        ? `${animationFrames[animationFrameIndex].label} · ${Math.min(Math.max(framesPerSecond, 1), 24)} FPS 预览`
                        : '等待动画帧'}
                    </span>
                  </div>

                  <div className="animation-actions">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => setAnimationPlaying((current) => !current)}
                    >
                      {animationPlaying ? '暂停' : '播放'}
                    </button>
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => {
                        setAnimationFrameIndex(0);
                        setAnimationPlaying(true);
                      }}
                    >
                      重播
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="preview-empty">
                生成完成后，这里会显示当前序列图效果。
              </div>
            )}
          </div>

          <div className="panel download-panel">
            <div className="panel-head">
              <h2>6. 导出结果</h2>
              <span>本地下载</span>
            </div>

            <p className="download-copy">
              支持导出序列图 PNG、动画 GIF、透明帧 ZIP 和 Spine ZIP；修改导出参数后会自动刷新当前序列图预览。
            </p>

            <div className="export-config-grid">
              <label className="field">
                <span>导出列数</span>
                <input
                  min={1}
                  max={8}
                  type="number"
                  value={columns}
                  onChange={(event) => setColumns(Number(event.target.value) || 1)}
                />
              </label>

              <label className="field">
                <span>导出间距（精灵图建议 0）</span>
                <input
                  min={0}
                  max={48}
                  type="number"
                  value={gap}
                  onChange={(event) => setGap(Number(event.target.value) || 0)}
                />
              </label>

              <label className="field">
                <span>单帧尺寸预设</span>
                <select
                  value={exportPreset}
                  onChange={(event) => setExportPreset(event.target.value as ExportPresetValue)}
                >
                  {EXPORT_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="option-card option-card--metric export-config-grid__full">
                <span>预估导出尺寸</span>
                <strong>
                  {exportTargetSize
                    ? `${exportTargetSize.width} × ${exportTargetSize.height}`
                    : '等待生成'}
                </strong>
                <small>
                  {exportFrameSize ? `智能缩放到每帧 ${exportFrameSize} × ${exportFrameSize}` : '保持原始帧比例尺寸'}
                </small>
              </div>
            </div>

            <div className="export-actions">
              <button
                className="secondary-button secondary-button--slate"
                disabled={isRendering}
                type="button"
                onClick={() => void handleOpenSpineWorkspace()}
              >
                进入 Spine 动画
              </button>

              <button
                className="secondary-button secondary-button--violet"
                disabled={isRendering}
                type="button"
                onClick={() => void handleDownloadSheet()}
              >
                {resultTransparent ? '下载透明序列图 PNG' : '下载普通序列图 PNG'}
              </button>

              <button
                className="secondary-button"
                disabled={isRendering}
                type="button"
                onClick={() => void handleDownloadGif()}
              >
                下载动画 GIF
              </button>

              <button
                className="secondary-button secondary-button--emerald"
                disabled={isRendering || !colorKeyOptions}
                type="button"
                onClick={() => void handleDownloadZip()}
              >
                下载透明单帧 ZIP
              </button>
            </div>
          </div>
        </section>
        ) : null}

        {showSpineStage && spineDraft ? (
          <section ref={spinePanelRef} className="result-grid spine-grid">
            <div className="panel preview-panel">
              <div className="panel-head">
                <h2>7. Spine 动画工作区</h2>
                <span>
                  {spineDraft.transparent ? '透明帧优先' : '普通帧'} · {spineDraft.width} × {spineDraft.height}
                </span>
              </div>

              <div className="spine-preview-note option-card option-card--metric">
                <span>当前资源</span>
                <strong>{spineDraft.frames.length} 帧</strong>
                <small>{spineDraft.baseName} · {spineOptions.fps} FPS</small>
              </div>

              <div
                className={`preview-wrap preview-wrap--animation ${
                  spineDraft.transparent ? 'preview-wrap--transparent' : 'preview-wrap--solid'
                }`}
              >
                <canvas
                  ref={spineAnimationCanvasRef}
                  aria-label="Spine 序列动画预览"
                  className="preview-canvas"
                />
              </div>

              <div className="animation-toolbar">
                <div className="animation-meta">
                  <strong>
                    第 {Math.min(spineAnimationFrameIndex + 1, spineFrames.length)} / {spineFrames.length} 帧
                  </strong>
                  <span>
                    {spineFrames[spineAnimationFrameIndex]
                      ? `${spineFrames[spineAnimationFrameIndex].label} · ${spineOptions.fps} FPS 预览`
                      : '等待 Spine 预览帧'}
                  </span>
                </div>

                <div className="animation-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setSpineAnimationPlaying((current) => !current)}
                  >
                    {spineAnimationPlaying ? '暂停' : '播放'}
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => {
                      setSpineAnimationFrameIndex(0);
                      setSpineAnimationPlaying(true);
                    }}
                  >
                    重播
                  </button>
                </div>
              </div>
            </div>

            <div className="panel download-panel">
              <div className="panel-head">
                <h2>Spine 导出参数</h2>
                <span>JSON + PNG ZIP</span>
              </div>

              <p className="download-copy">
                导出会生成 `skeleton.json`、`images/*.png` 和 `README.txt`，适合继续导入 Spine 作为单槽位逐帧动画。
              </p>

              <div className="export-config-grid">
                <label className="field">
                  <span>骨骼名</span>
                  <input
                    type="text"
                    value={spineOptions.skeletonName}
                    onChange={(event) =>
                      setSpineOptions((current) => ({
                        ...current,
                        skeletonName: event.target.value || baseFileName,
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>动画名</span>
                  <input
                    type="text"
                    value={spineOptions.animationName}
                    onChange={(event) =>
                      setSpineOptions((current) => ({
                        ...current,
                        animationName: event.target.value || 'idle',
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>插槽名</span>
                  <input
                    type="text"
                    value={spineOptions.slotName}
                    onChange={(event) =>
                      setSpineOptions((current) => ({
                        ...current,
                        slotName: event.target.value || 'sprite',
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>导出 FPS</span>
                  <input
                    min={1}
                    max={60}
                    type="number"
                    value={spineOptions.fps}
                    onChange={(event) =>
                      setSpineOptions((current) => ({
                        ...current,
                        fps: Math.min(Math.max(Number(event.target.value) || 1, 1), 60),
                      }))
                    }
                  />
                </label>

                <label className="toggle-card export-config-grid__full">
                  <input
                    checked={spineLoopPreview}
                    type="checkbox"
                    onChange={(event) => setSpineLoopPreview(event.target.checked)}
                  />
                  <span>循环预览</span>
                </label>
              </div>

              <div className="export-actions">
                <button
                  className="secondary-button secondary-button--emerald"
                  disabled={isRendering}
                  type="button"
                  onClick={() => void handleDownloadSpineZip()}
                >
                  下载 Spine ZIP
                </button>
              </div>
            </div>
          </section>
        ) : null}

        <footer className="app-footer">
          <div className="app-footer__brand">
            <img
              className="app-footer__avatar"
              src={BRAND_ASSET_PATH}
              alt="mowangblog 版权标识"
            />
            <div className="app-footer__copy">
              <strong>© {currentYear} 今天又被Godot打了</strong>
              <span>视频转序列帧表</span>
            </div>
          </div>
          <p className="app-footer__note">永久免费工具，欢迎一键三连➕关注支持更新。</p>
        </footer>
      </main>
    </div>
  );
}

export default App;
