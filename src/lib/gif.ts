import type { ExtractedFrame } from '../types';

const GIF_SIGNATURE = 'GIF89a';
const GIF_TRAILER = 0x3b;
const MAX_GIF_COLORS = 256;
const MAX_GIF_CODE_SIZE = 12;
const MAX_LZW_CODE = (1 << MAX_GIF_CODE_SIZE) - 1;
const COLOR_BIN_LEVELS = 32;
const COLOR_BIN_COUNT = COLOR_BIN_LEVELS * COLOR_BIN_LEVELS * COLOR_BIN_LEVELS;
const DEFAULT_ALPHA_THRESHOLD = 96;
const DEFAULT_SAMPLE_PIXEL_BUDGET = 220_000;
const PROGRESS_YIELD_INTERVAL = 4;

export type GifBuildProgress = {
  phase: 'palette' | 'encode';
  current: number;
  total: number;
};

export type GifBuildOptions = {
  fps: number;
  loop?: boolean;
  transparent?: boolean;
  maxColors?: number;
  alphaThreshold?: number;
  onProgress?: (progress: GifBuildProgress) => void;
};

type ColorStat = {
  count: number;
  r: number;
  g: number;
  b: number;
};

type PaletteEntry = {
  index: number;
  r: number;
  g: number;
  b: number;
};

type PaletteBuildResult = {
  table: Uint8Array;
  paletteEntries: PaletteEntry[];
  binToPalette: Int16Array;
  transparentIndex: number | null;
};

class ByteWriter {
  private bytes: number[] = [];

  writeByte(value: number): void {
    this.bytes.push(value & 0xff);
  }

  writeShort(value: number): void {
    this.writeByte(value & 0xff);
    this.writeByte((value >> 8) & 0xff);
  }

  writeBytes(values: ArrayLike<number>): void {
    for (let index = 0; index < values.length; index += 1) {
      this.writeByte(values[index] ?? 0);
    }
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

class BitWriter {
  private bytes: number[] = [];
  private currentByte = 0;
  private bitOffset = 0;

  write(code: number, size: number): void {
    let value = code;
    let bits = size;

    while (bits > 0) {
      this.currentByte |= (value & 1) << this.bitOffset;
      value >>= 1;
      this.bitOffset += 1;
      bits -= 1;

      if (this.bitOffset >= 8) {
        this.bytes.push(this.currentByte);
        this.currentByte = 0;
        this.bitOffset = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.bitOffset > 0) {
      this.bytes.push(this.currentByte);
      this.currentByte = 0;
      this.bitOffset = 0;
    }

    return Uint8Array.from(this.bytes);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function ceilPowerOfTwo(input: number): number {
  let value = Math.max(2, input);

  if ((value & (value - 1)) === 0) {
    return value;
  }

  value -= 1;
  value |= value >> 1;
  value |= value >> 2;
  value |= value >> 4;
  value |= value >> 8;
  value |= value >> 16;
  return value + 1;
}

function getCanvasImageData(canvas: HTMLCanvasElement, width: number, height: number): Uint8ClampedArray {
  if (canvas.width !== width || canvas.height !== height) {
    throw new Error('GIF 导出失败：检测到帧尺寸不一致。');
  }

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('GIF 导出失败：当前浏览器不支持 Canvas 2D。');
  }

  return context.getImageData(0, 0, width, height).data;
}

function getBinIndex(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

function pickPaletteColors(
  colorStats: ColorStat[],
  targetCount: number,
): Array<{ bin: number; r: number; g: number; b: number }> {
  const binsWithColor: number[] = [];

  for (let index = 0; index < colorStats.length; index += 1) {
    if ((colorStats[index]?.count ?? 0) > 0) {
      binsWithColor.push(index);
    }
  }

  if (binsWithColor.length <= targetCount) {
    return binsWithColor.map((bin) => {
      const entry = colorStats[bin] as ColorStat;
      return {
        bin,
        r: Math.round(entry.r / entry.count),
        g: Math.round(entry.g / entry.count),
        b: Math.round(entry.b / entry.count),
      };
    });
  }

  binsWithColor.sort((left, right) => {
    const leftCount = colorStats[left]?.count ?? 0;
    const rightCount = colorStats[right]?.count ?? 0;
    return rightCount - leftCount;
  });

  return binsWithColor.slice(0, targetCount).map((bin) => {
    const entry = colorStats[bin] as ColorStat;
    return {
      bin,
      r: Math.round(entry.r / entry.count),
      g: Math.round(entry.g / entry.count),
      b: Math.round(entry.b / entry.count),
    };
  });
}

function findNearestPaletteColorIndex(
  r: number,
  g: number,
  b: number,
  paletteEntries: PaletteEntry[],
): number {
  let nearestIndex = paletteEntries[0]?.index ?? 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const entry of paletteEntries) {
    const dr = r - entry.r;
    const dg = g - entry.g;
    const db = b - entry.b;
    const distance = dr * dr + dg * dg + db * db;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = entry.index;

      if (distance === 0) {
        break;
      }
    }
  }

  return nearestIndex;
}

function buildPalette(
  frameData: Uint8ClampedArray[],
  options: {
    maxColors: number;
    transparent: boolean;
    alphaThreshold: number;
  },
): PaletteBuildResult {
  const colorStats: ColorStat[] = Array.from({ length: COLOR_BIN_COUNT }, () => ({
    count: 0,
    r: 0,
    g: 0,
    b: 0,
  }));

  let hasTransparentPixel = false;
  let totalPixels = 0;

  for (const data of frameData) {
    totalPixels += data.length / 4;
  }

  const sampleStride = Math.max(1, Math.floor(Math.sqrt(totalPixels / DEFAULT_SAMPLE_PIXEL_BUDGET)));

  for (const data of frameData) {
    for (let index = 0; index < data.length; index += 4 * sampleStride) {
      const alpha = data[index + 3] ?? 255;
      if (options.transparent && alpha < options.alphaThreshold) {
        hasTransparentPixel = true;
        continue;
      }

      const r = data[index] ?? 0;
      const g = data[index + 1] ?? 0;
      const b = data[index + 2] ?? 0;
      const bin = getBinIndex(r, g, b);
      const stat = colorStats[bin];

      stat.count += 1;
      stat.r += r;
      stat.g += g;
      stat.b += b;
    }
  }

  const reserveTransparentSlot = options.transparent && hasTransparentPixel;
  const maxPaletteColors = clamp(
    reserveTransparentSlot ? options.maxColors - 1 : options.maxColors,
    1,
    reserveTransparentSlot ? MAX_GIF_COLORS - 1 : MAX_GIF_COLORS,
  );
  const pickedColors = pickPaletteColors(colorStats, maxPaletteColors);
  const tableStartIndex = reserveTransparentSlot ? 1 : 0;
  const paletteEntries: PaletteEntry[] = pickedColors.map((color, index) => ({
    index: tableStartIndex + index,
    r: color.r,
    g: color.g,
    b: color.b,
  }));

  if (paletteEntries.length === 0) {
    paletteEntries.push({
      index: tableStartIndex,
      r: 0,
      g: 0,
      b: 0,
    });
  }

  const tableSize = ceilPowerOfTwo(Math.min(MAX_GIF_COLORS, paletteEntries.length + tableStartIndex));
  const table = new Uint8Array(tableSize * 3);

  if (reserveTransparentSlot) {
    table[0] = 0;
    table[1] = 0;
    table[2] = 0;
  }

  for (const entry of paletteEntries) {
    const tableOffset = entry.index * 3;
    table[tableOffset] = entry.r;
    table[tableOffset + 1] = entry.g;
    table[tableOffset + 2] = entry.b;
  }

  const binToPalette = new Int16Array(COLOR_BIN_COUNT);
  binToPalette.fill(-1);

  for (const color of pickedColors) {
    const mapped = paletteEntries.find((entry) => entry.r === color.r && entry.g === color.g && entry.b === color.b);
    if (mapped) {
      binToPalette[color.bin] = mapped.index;
    }
  }

  return {
    table,
    paletteEntries,
    binToPalette,
    transparentIndex: reserveTransparentSlot ? 0 : null,
  };
}

function buildIndexedPixels(
  data: Uint8ClampedArray,
  palette: PaletteBuildResult,
  alphaThreshold: number,
): Uint8Array {
  const pixelCount = data.length / 4;
  const indexed = new Uint8Array(pixelCount);

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const alpha = data[offset + 3] ?? 255;

    if (palette.transparentIndex !== null && alpha < alphaThreshold) {
      indexed[pixel] = palette.transparentIndex;
      continue;
    }

    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    const bin = getBinIndex(r, g, b);
    const cachedIndex = palette.binToPalette[bin];

    if (cachedIndex >= 0) {
      indexed[pixel] = cachedIndex;
      continue;
    }

    const nearest = findNearestPaletteColorIndex(r, g, b, palette.paletteEntries);
    palette.binToPalette[bin] = nearest;
    indexed[pixel] = nearest;
  }

  return indexed;
}

function writeSubBlocks(writer: ByteWriter, data: Uint8Array): void {
  let offset = 0;

  while (offset < data.length) {
    const chunkSize = Math.min(255, data.length - offset);
    writer.writeByte(chunkSize);
    writer.writeBytes(data.subarray(offset, offset + chunkSize));
    offset += chunkSize;
  }

  writer.writeByte(0);
}

function encodeLzwIndices(indexedPixels: Uint8Array, minCodeSize: number): Uint8Array {
  const bitWriter = new BitWriter();
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;
  const dictionary = new Map<number, number>();

  const resetDictionary = (): void => {
    dictionary.clear();
    nextCode = endCode + 1;
    codeSize = minCodeSize + 1;
  };

  bitWriter.write(clearCode, codeSize);

  if (indexedPixels.length === 0) {
    bitWriter.write(endCode, codeSize);
    return bitWriter.finish();
  }

  let prefix = indexedPixels[0] ?? 0;

  for (let index = 1; index < indexedPixels.length; index += 1) {
    const suffix = indexedPixels[index] ?? 0;
    const key = (prefix << 8) | suffix;
    const existing = dictionary.get(key);

    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    bitWriter.write(prefix, codeSize);

    if (nextCode <= MAX_LZW_CODE) {
      dictionary.set(key, nextCode);
      nextCode += 1;

      if (nextCode === 1 << codeSize && codeSize < MAX_GIF_CODE_SIZE) {
        codeSize += 1;
      }
    } else {
      bitWriter.write(clearCode, codeSize);
      resetDictionary();
    }

    prefix = suffix;
  }

  bitWriter.write(prefix, codeSize);
  bitWriter.write(endCode, codeSize);

  return bitWriter.finish();
}

function writeNetscapeLoopExtension(writer: ByteWriter, loopCount: number): void {
  writer.writeByte(0x21);
  writer.writeByte(0xff);
  writer.writeByte(0x0b);
  writer.writeBytes([0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30]);
  writer.writeByte(0x03);
  writer.writeByte(0x01);
  writer.writeShort(clamp(loopCount, 0, 65_535));
  writer.writeByte(0x00);
}

function writeGraphicControlExtension(
  writer: ByteWriter,
  delayCs: number,
  transparentIndex: number | null,
): void {
  const transparentFlag = transparentIndex !== null ? 1 : 0;
  const disposalMethod = transparentIndex !== null ? 2 : 0;
  const packed = (disposalMethod << 2) | transparentFlag;

  writer.writeByte(0x21);
  writer.writeByte(0xf9);
  writer.writeByte(0x04);
  writer.writeByte(packed);
  writer.writeShort(clamp(delayCs, 1, 65_535));
  writer.writeByte(transparentIndex ?? 0);
  writer.writeByte(0x00);
}

function writeImageDescriptor(
  writer: ByteWriter,
  width: number,
  height: number,
): void {
  writer.writeByte(0x2c);
  writer.writeShort(0);
  writer.writeShort(0);
  writer.writeShort(width);
  writer.writeShort(height);
  writer.writeByte(0x00);
}

function getTableBitSize(table: Uint8Array): number {
  return Math.max(1, Math.ceil(Math.log2(Math.max(2, table.length / 3))));
}

function getDelayFromFrames(
  frames: ExtractedFrame[],
  fallbackFps: number,
  index: number,
): number {
  const fallbackSeconds = 1 / Math.max(fallbackFps, 1);
  const nextFrame = frames[index + 1];
  const currentFrame = frames[index];

  if (nextFrame && nextFrame.time > currentFrame.time) {
    return clamp(Math.round((nextFrame.time - currentFrame.time) * 100), 1, 65_535);
  }

  if (index > 0) {
    const previousFrame = frames[index - 1];
    if (currentFrame.time > previousFrame.time) {
      return clamp(Math.round((currentFrame.time - previousFrame.time) * 100), 1, 65_535);
    }
  }

  return clamp(Math.round(fallbackSeconds * 100), 1, 65_535);
}

function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

export function deriveGifFrameDelays(frames: ExtractedFrame[], fallbackFps: number): number[] {
  return frames.map((_, index) => getDelayFromFrames(frames, fallbackFps, index));
}

export async function buildAnimatedGif(
  frames: ExtractedFrame[],
  options: GifBuildOptions,
): Promise<Blob> {
  if (!frames.length) {
    throw new Error('GIF 导出失败：请先生成至少 1 帧。');
  }

  const width = frames[0]?.image.width ?? 0;
  const height = frames[0]?.image.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw new Error('GIF 导出失败：帧尺寸无效。');
  }

  const normalizedFps = clamp(options.fps, 1, 60);
  const normalizedMaxColors = clamp(
    Math.floor(options.maxColors ?? MAX_GIF_COLORS),
    2,
    MAX_GIF_COLORS,
  );
  const alphaThreshold = clamp(
    options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD,
    1,
    255,
  );
  const transparent = Boolean(options.transparent);
  const frameData: Uint8ClampedArray[] = [];

  for (const [index, frame] of frames.entries()) {
    frameData.push(getCanvasImageData(frame.image, width, height));
    options.onProgress?.({
      phase: 'palette',
      current: index + 1,
      total: frames.length,
    });

    if ((index + 1) % PROGRESS_YIELD_INTERVAL === 0 && index < frames.length - 1) {
      await waitForNextFrame();
    }
  }

  const palette = buildPalette(frameData, {
    maxColors: normalizedMaxColors,
    transparent,
    alphaThreshold,
  });
  const tableBitSize = getTableBitSize(palette.table);
  const colorTableSizeValue = clamp(tableBitSize - 1, 0, 7);
  const lzwMinCodeSize = Math.max(2, tableBitSize);
  const delays = deriveGifFrameDelays(frames, normalizedFps);
  const writer = new ByteWriter();

  writer.writeBytes(Array.from(GIF_SIGNATURE).map((char) => char.charCodeAt(0)));
  writer.writeShort(width);
  writer.writeShort(height);
  writer.writeByte(0x80 | (7 << 4) | colorTableSizeValue);
  writer.writeByte(0);
  writer.writeByte(0);
  writer.writeBytes(palette.table);

  if (options.loop !== false) {
    writeNetscapeLoopExtension(writer, 0);
  }

  for (let index = 0; index < frameData.length; index += 1) {
    const indexedPixels = buildIndexedPixels(frameData[index] as Uint8ClampedArray, palette, alphaThreshold);
    const lzwData = encodeLzwIndices(indexedPixels, lzwMinCodeSize);

    writeGraphicControlExtension(
      writer,
      delays[index] ?? 10,
      palette.transparentIndex,
    );
    writeImageDescriptor(writer, width, height);
    writer.writeByte(lzwMinCodeSize);
    writeSubBlocks(writer, lzwData);
    options.onProgress?.({
      phase: 'encode',
      current: index + 1,
      total: frameData.length,
    });

    if ((index + 1) % PROGRESS_YIELD_INTERVAL === 0 && index < frameData.length - 1) {
      await waitForNextFrame();
    }
  }

  writer.writeByte(GIF_TRAILER);

  const bytes = writer.toUint8Array().slice();
  return new Blob([bytes], { type: 'image/gif' });
}
