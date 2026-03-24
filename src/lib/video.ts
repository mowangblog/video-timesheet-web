import type {
  CropArea,
  CropBounds,
  ExtractedFrame,
  ExtractionOptions,
  VideoMeta,
} from '../types';
import { formatTimestamp } from './time';

type VideoAsset = {
  url: string;
  meta: VideoMeta;
};

export type VideoFrameReader = {
  captureFrameAt: (time: number) => Promise<HTMLCanvasElement>;
  dispose: () => void;
};

const MIN_CROP_PERCENT = 1;
const MAX_CROP_PERCENT = 100;

function waitForEvent<T extends keyof HTMLMediaElementEventMap>(
  target: HTMLVideoElement,
  event: T,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      target.removeEventListener(event, onSuccess);
      target.removeEventListener('error', onError);
    };

    const onSuccess = (): void => {
      cleanup();
      resolve();
    };

    const onError = (): void => {
      cleanup();
      reject(new Error('视频读取失败，请检查文件是否可被当前浏览器解码。'));
    };

    target.addEventListener(event, onSuccess, { once: true });
    target.addEventListener('error', onError, { once: true });
  });
}

function createVideoElement(videoUrl: string): HTMLVideoElement {
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = videoUrl;
  return video;
}

async function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.001) {
    return;
  }

  const promise = waitForEvent(video, 'seeked');
  video.currentTime = time;
  await promise;
}

function drawFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('当前浏览器无法创建 Canvas 绘图上下文。');
  }

  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function releaseVideoElement(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

export async function loadVideoAsset(file: File): Promise<VideoAsset> {
  const url = URL.createObjectURL(file);
  const video = createVideoElement(url);

  try {
    await waitForEvent(video, 'loadedmetadata');
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }

  const width = video.videoWidth;
  const height = video.videoHeight;
  const duration = video.duration;
  releaseVideoElement(video);

  if (!width || !height || !duration || !Number.isFinite(duration)) {
    URL.revokeObjectURL(url);
    throw new Error('无法读取视频元数据，请换一个常见编码的 MP4 文件后重试。');
  }

  return {
    url,
    meta: {
      duration,
      width,
      height,
      name: file.name,
    },
  };
}

export function revokeVideoAsset(url: string): void {
  URL.revokeObjectURL(url);
}

export async function createVideoFrameReader(videoUrl: string): Promise<VideoFrameReader> {
  const video = createVideoElement(videoUrl);
  await waitForEvent(video, 'loadeddata');

  return {
    captureFrameAt: async (time: number): Promise<HTMLCanvasElement> => {
      const clampedTime = Math.max(0, Math.min(time, video.duration || time));
      await seekTo(video, clampedTime);
      return drawFrame(video);
    },
    dispose: (): void => {
      releaseVideoElement(video);
    },
  };
}

function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) {
    return 0;
  }

  return Math.max(0, Math.min(time, duration));
}

function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

export function normalizeCropArea(cropArea?: CropArea | null): CropArea {
  if (!cropArea) {
    return {
      leftPercent: 0,
      topPercent: 0,
      widthPercent: 100,
      heightPercent: 100,
    };
  }

  const leftPercent = clampValue(cropArea.leftPercent, 0, MAX_CROP_PERCENT - MIN_CROP_PERCENT);
  const topPercent = clampValue(cropArea.topPercent, 0, MAX_CROP_PERCENT - MIN_CROP_PERCENT);
  const widthLimit = MAX_CROP_PERCENT - leftPercent;
  const heightLimit = MAX_CROP_PERCENT - topPercent;

  return {
    leftPercent,
    topPercent,
    widthPercent: clampValue(cropArea.widthPercent, MIN_CROP_PERCENT, widthLimit),
    heightPercent: clampValue(cropArea.heightPercent, MIN_CROP_PERCENT, heightLimit),
  };
}

export function getCropBounds(
  sourceWidth: number,
  sourceHeight: number,
  cropArea?: CropArea | null,
): CropBounds {
  const width = Math.max(1, Math.round(sourceWidth));
  const height = Math.max(1, Math.round(sourceHeight));
  const normalized = normalizeCropArea(cropArea);

  const x = Math.floor((normalized.leftPercent / 100) * width);
  const y = Math.floor((normalized.topPercent / 100) * height);
  const maxCropWidth = Math.max(1, width - x);
  const maxCropHeight = Math.max(1, height - y);
  const rawCropWidth = Math.round((normalized.widthPercent / 100) * width);
  const rawCropHeight = Math.round((normalized.heightPercent / 100) * height);

  return {
    x,
    y,
    width: clampValue(rawCropWidth, 1, maxCropWidth),
    height: clampValue(rawCropHeight, 1, maxCropHeight),
  };
}

export function cropCanvas(
  source: HTMLCanvasElement,
  cropArea?: CropArea | null,
): HTMLCanvasElement {
  const bounds = getCropBounds(source.width, source.height, cropArea);
  const isFullFrame =
    bounds.x === 0 &&
    bounds.y === 0 &&
    bounds.width === source.width &&
    bounds.height === source.height;

  if (isFullFrame) {
    return source;
  }

  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('当前浏览器无法创建 Canvas 绘图上下文。');
  }

  context.drawImage(
    source,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );

  return canvas;
}

export function getSampleTimes(
  duration: number,
  framesPerSecond: number,
  segmentStart = 0,
  segmentEnd = duration,
): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || framesPerSecond <= 0) {
    return [];
  }

  const rawStart = clampTime(Math.min(segmentStart, segmentEnd), duration);
  const rawEnd = clampTime(Math.max(segmentStart, segmentEnd), duration);
  const segmentDuration = rawEnd - rawStart;

  if (segmentDuration <= 0.001) {
    return [Number(rawStart.toFixed(3))];
  }

  const margin = Math.min(0.2, segmentDuration * 0.05);
  const safeStart = rawStart + margin;
  const safeEnd = rawEnd - margin;
  const safeDuration = safeEnd - safeStart;

  if (safeDuration <= 0) {
    return [Number(((rawStart + rawEnd) / 2).toFixed(3))];
  }

  const frameCount = Math.floor(safeDuration * framesPerSecond) + 1;

  if (frameCount <= 1) {
    return [Number(((safeStart + safeEnd) / 2).toFixed(3))];
  }

  const step = safeDuration / (frameCount - 1);
  return Array.from({ length: frameCount }, (_, index) => {
    const next = safeStart + step * index;
    return Number(Math.min(duration, Math.max(0, next)).toFixed(3));
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export async function extractFrames(
  videoUrl: string,
  meta: VideoMeta,
  options: ExtractionOptions,
  onProgress?: (current: number, total: number, time: number) => void,
): Promise<ExtractedFrame[]> {
  const reader = await createVideoFrameReader(videoUrl);

  try {
    const sampleTimes = getSampleTimes(
      meta.duration,
      options.framesPerSecond,
      options.segmentStart,
      options.segmentEnd,
    );
    const frames: ExtractedFrame[] = [];

    for (const [index, time] of sampleTimes.entries()) {
      const image = await reader.captureFrameAt(time);
      const croppedImage = cropCanvas(image, options.cropArea);
      frames.push({
        image: croppedImage,
        time,
        label: formatTimestamp(time),
      });

      onProgress?.(index + 1, sampleTimes.length, time);
      if (index < sampleTimes.length - 1) {
        await nextFrame();
      }
    }

    return frames;
  } finally {
    reader.dispose();
  }
}
