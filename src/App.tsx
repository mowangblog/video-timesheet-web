import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type {
  ColorKeyOptions,
  ColorSample,
  ExtractedFrame,
  KeyAlgorithm,
  PreviewMode,
  ProcessedFrame,
  RenderResult,
  SheetOptions,
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
  getSheetFileName,
  getZipFileName,
} from './lib/exportBundle';
import { getSheetAppearance, renderFrameSheet } from './lib/sheet';
import { formatTimestamp } from './lib/time';
import {
  createVideoFrameReader,
  extractFrames,
  getSampleTimes,
  loadVideoAsset,
  revokeVideoAsset,
  type VideoFrameReader,
} from './lib/video';

const DEFAULT_FRAMES_PER_SECOND = 12;
const DEFAULT_COLUMNS = 4;
const DEFAULT_GAP = 8;
const DEFAULT_KEY_ALGORITHM: KeyAlgorithm = 'enhanced';
const DEFAULT_TOLERANCE = 28;
const DEFAULT_SOFTNESS = 14;
const DEFAULT_DESPILL = 50;
const DEFAULT_EDGE_RADIUS = 22;
const DEFAULT_SAMPLE_RADIUS = 6;
const DEFAULT_SOLID_PREVIEW_BG = '#111827';
const MAX_EXTRACTED_FRAMES = 180;

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

function toTransparentSheetFrames(processedFrames: ProcessedFrame[]): ExtractedFrame[] {
  return processedFrames.map(({ processedImage, ...frame }) => ({
    ...frame,
    image: processedImage,
  }));
}

function App() {
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isChromaStageOpen, setIsChromaStageOpen] = useState(false);
  const [framesPerSecond, setFramesPerSecond] = useState(DEFAULT_FRAMES_PER_SECOND);
  const [segmentStart, setSegmentStart] = useState(0);
  const [segmentEnd, setSegmentEnd] = useState(0);
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  const [gap, setGap] = useState(DEFAULT_GAP);
  const [tolerance, setTolerance] = useState(DEFAULT_TOLERANCE);
  const [softness, setSoftness] = useState(DEFAULT_SOFTNESS);
  const [despill, setDespill] = useState(DEFAULT_DESPILL);
  const [edgeRadius, setEdgeRadius] = useState(DEFAULT_EDGE_RADIUS);
  const [sampleRadius, setSampleRadius] = useState(DEFAULT_SAMPLE_RADIUS);
  const [smoothing, setSmoothing] = useState(true);
  const [despillEnabled, setDespillEnabled] = useState(true);
  const [referenceTime, setReferenceTime] = useState(0);
  const [referenceFrame, setReferenceFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceResultFrame, setReferenceResultFrame] = useState<HTMLCanvasElement | null>(null);
  const [referenceMaskFrame, setReferenceMaskFrame] = useState<HTMLCanvasElement | null>(null);
  const [samplePoint, setSamplePoint] = useState<SamplePoint | null>(null);
  const [colorSample, setColorSample] = useState<ColorSample | null>(null);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('result');
  const [solidPreviewColor, setSolidPreviewColor] = useState(DEFAULT_SOLID_PREVIEW_BG);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [resultTransparent, setResultTransparent] = useState(false);
  const [status, setStatus] = useState('请选择一个本地视频开始生成。');
  const [isDragging, setIsDragging] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isReferenceLoading, setIsReferenceLoading] = useState(false);
  const [readerReady, setReaderReady] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [extractedFrames, setExtractedFrames] = useState<ExtractedFrame[] | null>(null);
  const [processedFrames, setProcessedFrames] = useState<ProcessedFrame[] | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const referenceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsPanelRef = useRef<HTMLDivElement | null>(null);
  const chromaPanelRef = useRef<HTMLElement | null>(null);
  const chromaActionsRef = useRef<HTMLDivElement | null>(null);
  const resultPanelRef = useRef<HTMLElement | null>(null);
  const readerRef = useRef<VideoFrameReader | null>(null);
  const readerTokenRef = useRef(0);
  const hasInitializedInvalidationRef = useRef(false);
  const latestVideoUrlRef = useRef<string | null>(null);
  const latestResultRef = useRef<RenderResult | null>(null);

  const sheetOptions: SheetOptions = {
    columns,
    gap,
    backgroundColor: '#ffffff',
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

  const colorKeyOptions = useMemo<ColorKeyOptions | null>(() => {
    if (!colorSample) {
      return null;
    }

    return {
      sample: colorSample,
      tolerance,
      softness,
      despill,
      sampleRadius,
      edgeRadius,
      smoothing,
      despillEnabled,
      algorithm: DEFAULT_KEY_ALGORITHM,
    };
  }, [
    colorSample,
    despill,
    despillEnabled,
    edgeRadius,
    sampleRadius,
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
    setExtractedFrames(null);
    setProcessedFrames(null);
    replacePreviewResult(null);
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

      if (latestVideoUrlRef.current) {
        revokeVideoAsset(latestVideoUrlRef.current);
      }

      if (latestResultRef.current) {
        URL.revokeObjectURL(latestResultRef.current.objectUrl);
      }
    };
  }, []);

  useEffect(() => {
    if (!videoUrl || !videoMeta) {
      disposeReferenceReader();
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

        setReferenceFrame(canvas);
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
    if (!videoMeta) {
      return;
    }

    const clampedTime = Math.min(Math.max(referenceTime, segmentStart), segmentEnd);
    if (Math.abs(clampedTime - referenceTime) > 0.001) {
      setReferenceTime(Number(clampedTime.toFixed(3)));
    }
  }, [referenceTime, segmentEnd, segmentStart, videoMeta]);

  useEffect(() => {
    if (!referenceFrame || !samplePoint) {
      setColorSample(null);
      return;
    }

    try {
      setColorSample(sampleCanvasColor(referenceFrame, samplePoint.x, samplePoint.y, sampleRadius));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '颜色取样失败。');
    }
  }, [referenceFrame, samplePoint, sampleRadius]);

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
    despill,
    despillEnabled,
    edgeRadius,
    framesPerSecond,
    samplePoint?.x,
    samplePoint?.y,
    sampleRadius,
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
    setReferenceFrame(null);
    setReferenceResultFrame(null);
    setReferenceMaskFrame(null);
    setSamplePoint(null);
    setColorSample(null);
    setIsChromaStageOpen(false);
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
      setStatus('视频已就绪，点击“提取帧”开始选择背景颜色。');
      scrollToStep(controlsPanelRef);
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
    if (!videoMeta) {
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
      videoMeta,
      sheetOptions,
      false,
      getSheetAppearance(transparent),
    );

    replacePreviewResult(renderResult, transparent);
    setStatus(transparent ? '透明序列图已生成，可以继续预览或下载。' : '普通序列图已生成，可以继续预览或下载。');

    return {
      renderResult,
      transparent,
    };
  }

  async function handleGeneratePreview(): Promise<void> {
    try {
      const assets = await ensureAssets();
      await renderSheetPreview(assets);
      scrollToStep(resultPanelRef);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '生成失败。');
      setStatus('生成失败，请调整参数后重试。');
    }
  }

  async function handleRefreshPreview(): Promise<void> {
    try {
      await renderSheetPreview();
      scrollToStep(resultPanelRef);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '预览失败。');
      setStatus('预览失败，请稍后再试。');
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
          <p className="eyebrow">本地处理 · 纯前端扣像 · GitHub Pages 友好</p>
          <h1>视频转序列帧表 2.0</h1>
          <p className="hero-copy">
            可以直接生成普通序列图，也可以先在参考帧中点击背景颜色，
            再批量执行浏览器端 ChromaKey 抠像并导出透明结果。
          </p>
        </section>

        <section className={`workspace-grid ${videoMeta ? '' : 'workspace-grid--single'}`}>
          <div className="panel upload-panel">
            <div className="panel-head">
              <h2>1. 上传视频</h2>
            </div>
            <div className="status-banner">{status}</div>

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

            {videoUrl ? (
              <div className="video-preview-card">
                <span>视频预览</span>
                <video className="upload-video-preview" controls muted playsInline src={videoUrl} />
              </div>
            ) : null}
          </div>

          {videoMeta ? (
            <div ref={controlsPanelRef} className="panel controls-panel">
              <div className="panel-head">
                <h2>2. 提取帧</h2>
              </div>
              <p className="panel-subtitle">设置每秒帧数和视频片段，再提取参考帧开始取色。</p>

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
                  setReferenceTime(firstSampleTime);
                  setIsChromaStageOpen(true);
                  setStatus('已提取片段中的第一张参考帧，可直接生成序列图，或先点背景颜色再做抠图。');
                  scrollToStep(chromaPanelRef);
                }}
              >
                {isChromaStageOpen ? '重新提取参考帧' : '提取帧'}
              </button>

              {frameLimitExceeded ? (
                <p className="error-text">当前设置预计提取 {estimatedFrameCount} 帧，建议缩短片段或降低每秒帧数。</p>
              ) : null}
              {error ? <p className="error-text">{error}</p> : null}
            </div>
          ) : null}
        </section>

        {showChromaStage ? (
        <section ref={chromaPanelRef} className="panel chroma-panel">
          <div className="panel-head panel-head--stack">
            <div>
              <h2>3. 参考帧与抠像预览</h2>
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
                  <span>容差、羽化、采样半径、去溢色都会即时影响右侧预览。</span>
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

                  <label className="range-field">
                    <span>边缘去溢色强度: {despill}%</span>
                    <input
                      max={100}
                      min={0}
                      type="range"
                      value={despill}
                      onChange={(event) => setDespill(Number(event.target.value))}
                    />
                    <small>用于压掉边缘残留的背景色，值越大处理越明显。</small>
                  </label>

                  <label className="range-field">
                    <span>边缘检测半径: {edgeRadius}px</span>
                    <input
                      max={60}
                      min={0}
                      type="range"
                      value={edgeRadius}
                      onChange={(event) => setEdgeRadius(Number(event.target.value))}
                    />
                    <small>控制去溢色主要作用在多宽的边缘区域内。</small>
                  </label>

                  <label className="range-field">
                    <span>颜色采样半径: {sampleRadius}px</span>
                    <input
                      max={20}
                      min={0}
                      type="range"
                      value={sampleRadius}
                      onChange={(event) => setSampleRadius(Number(event.target.value))}
                    />
                    <small>取样时会平均周围像素，适合带轻微噪点的背景。</small>
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
              <h2>4. 序列图预览</h2>
              <span>
                {result
                  ? `${resultTransparent ? '透明序列图' : '普通序列图'} · ${result.outputWidth} × ${result.outputHeight}`
                  : '等待生成'}
              </span>
            </div>

            {result ? (
              <div className="preview-wrap">
                <img alt="生成的序列帧表预览" className="preview-image" src={result.objectUrl} />
              </div>
            ) : (
              <div className="preview-empty">
                生成完成后，这里会显示当前序列图效果。
              </div>
            )}
          </div>

          <div className="panel download-panel">
            <div className="panel-head">
              <h2>5. 导出结果</h2>
              <span>本地下载</span>
            </div>

            <p className="download-copy">
              导出前可以改列数和间距，先预览当前序列图效果，再决定下载普通图或透明图。
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
                <span>导出间距</span>
                <input
                  min={0}
                  max={48}
                  type="number"
                  value={gap}
                  onChange={(event) => setGap(Number(event.target.value) || 0)}
                />
              </label>
            </div>

            <div className="export-actions">
              <button
                className="secondary-button"
                disabled={isRendering}
                type="button"
                onClick={() => void handleRefreshPreview()}
              >
                预览当前序列图
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
      </main>
    </div>
  );
}

export default App;
