import JSZip from 'jszip';
import type { SpineDraft, SpineExportOptions } from '../types';
import { getBaseFileName } from './exportBundle';

type SpineAttachment = {
  type: 'region';
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type SpineSkeletonJson = {
  skeleton: {
    name: string;
    spine: string;
    images: string;
  };
  bones: Array<{
    name: string;
  }>;
  slots: Array<{
    name: string;
    bone: string;
    attachment: string;
  }>;
  skins: Array<{
    name: 'default';
    attachments: Record<string, Record<string, SpineAttachment>>;
  }>;
  animations: Record<
    string,
    {
      slots: Record<
        string,
        {
          attachment: Array<{
            time: number;
            name: string;
          }>;
        }
      >;
    }
  >;
};

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Spine 帧导出失败，请稍后重试。'));
        return;
      }

      resolve(blob);
    }, 'image/png');
  });
}

export function getSpineJsonFileName(baseName: string): string {
  return `${getBaseFileName(baseName)}-spine.json`;
}

export function getSpineZipFileName(baseName: string): string {
  return `${getBaseFileName(baseName)}-spine.zip`;
}

export function getSpineFrameStem(baseName: string, index: number): string {
  const frameNumber = String(index + 1).padStart(3, '0');
  return `${getBaseFileName(baseName)}-spine-${frameNumber}`;
}

export function getSpineFrameFileName(baseName: string, index: number): string {
  return `images/${getSpineFrameStem(baseName, index)}.png`;
}

export function buildSpineReadme(draft: SpineDraft, options: SpineExportOptions): string {
  return [
    'Spine 动画导出说明',
    '',
    '此 ZIP 包包含：',
    `- ${getSpineJsonFileName(draft.baseName)}`,
    '- images/*.png',
    '',
    '导入建议：',
    '1. 将 ZIP 解压到本地目录。',
    '2. 在 Spine 中使用 Import Data 或作为新 skeleton 导入 JSON。',
    '3. 保持 JSON 文件与 images 文件夹的相对路径不变。',
    '',
    '当前导出参数：',
    `- skeleton: ${options.skeletonName}`,
    `- animation: ${options.animationName}`,
    `- slot: ${options.slotName}`,
    `- fps: ${options.fps}`,
    `- frames: ${draft.frames.length}`,
    `- transparent: ${draft.transparent ? 'yes' : 'no'}`,
  ].join('\n');
}

export function buildSpineSkeletonData(
  draft: SpineDraft,
  options: SpineExportOptions,
): SpineSkeletonJson {
  const attachmentEntries = Object.fromEntries(
    draft.frames.map((_, index) => {
      const attachmentName = getSpineFrameStem(draft.baseName, index);
      return [
        attachmentName,
        {
          type: 'region' as const,
          path: `images/${attachmentName}`,
          x: 0,
          y: 0,
          width: draft.width,
          height: draft.height,
        },
      ];
    }),
  );

  const attachmentTimeline = draft.frames.slice(1).map((_, index) => ({
    time: Number(((index + 1) / Math.max(options.fps, 1)).toFixed(6)),
    name: getSpineFrameStem(draft.baseName, index + 1),
  }));

  return {
    skeleton: {
      name: options.skeletonName,
      spine: '4.2.0',
      images: './images/',
    },
    bones: [
      {
        name: 'root',
      },
    ],
    slots: [
      {
        name: options.slotName,
        bone: 'root',
        attachment: getSpineFrameStem(draft.baseName, 0),
      },
    ],
    skins: [
      {
        name: 'default',
        attachments: {
          [options.slotName]: attachmentEntries,
        },
      },
    ],
    animations: {
      [options.animationName]: {
        slots: {
          [options.slotName]: {
            attachment: attachmentTimeline,
          },
        },
      },
    },
  };
}

export async function buildSpineBundleZip(
  draft: SpineDraft,
  options: SpineExportOptions,
): Promise<Blob> {
  const zip = new JSZip();
  const jsonFileName = getSpineJsonFileName(draft.baseName);
  const jsonData = buildSpineSkeletonData(draft, options);

  zip.file(jsonFileName, JSON.stringify(jsonData, null, 2));
  zip.file('README.txt', buildSpineReadme(draft, options));

  for (const [index, frame] of draft.frames.entries()) {
    const blob = await canvasToBlob(frame.image);
    zip.file(getSpineFrameFileName(draft.baseName, index), blob);
  }

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
