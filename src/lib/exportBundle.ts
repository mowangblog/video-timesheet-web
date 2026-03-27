import JSZip from 'jszip';
import type { ProcessedFrame } from '../types';
import { formatTimestamp } from './time';

function sanitizeBaseName(input: string): string {
  return (
    input
      .replace(/\.[^.]+$/, '')
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'video'
  );
}

function safeTimestampLabel(time: number): string {
  return formatTimestamp(time).replace(/[.:]/g, '-');
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('透明帧导出失败，请稍后重试。'));
        return;
      }

      resolve(blob);
    }, 'image/png');
  });
}

export function getBaseFileName(input: string): string {
  return sanitizeBaseName(input);
}

export function getSheetFileName(baseName: string, transparent: boolean): string {
  const safeBase = sanitizeBaseName(baseName);
  return `${safeBase}${transparent ? '-transparent' : ''}-timesheet.png`;
}

export function getFrameFileName(baseName: string, index: number, time: number): string {
  const safeBase = sanitizeBaseName(baseName);
  const frameNumber = String(index + 1).padStart(3, '0');
  return `${safeBase}-frame-${frameNumber}-${safeTimestampLabel(time)}.png`;
}

export function getZipFileName(baseName: string): string {
  return `${sanitizeBaseName(baseName)}-frames.zip`;
}

export function getGifFileName(baseName: string, transparent: boolean): string {
  const safeBase = sanitizeBaseName(baseName);
  return `${safeBase}${transparent ? '-transparent' : ''}-animation.gif`;
}

export async function buildTransparentFramesZip(
  frames: ProcessedFrame[],
  baseName: string,
): Promise<Blob> {
  const zip = new JSZip();

  for (const [index, frame] of frames.entries()) {
    const blob = await canvasToBlob(frame.processedImage);
    zip.file(getFrameFileName(baseName, index, frame.time), blob);
  }

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
