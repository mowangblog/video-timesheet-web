import { describe, expect, it } from 'vitest';
import type { ExtractedFrame } from '../types';
import { buildAnimatedGif, deriveGifFrameDelays } from './gif';

function mockFrame(time: number): ExtractedFrame {
  return {
    image: {} as HTMLCanvasElement,
    time,
    label: String(time),
  };
}

describe('gif helpers', () => {
  it('derives delay from neighbor frame timestamps', () => {
    const frames = [mockFrame(0), mockFrame(0.08), mockFrame(0.17)];

    expect(deriveGifFrameDelays(frames, 12)).toEqual([8, 9, 9]);
  });

  it('falls back to fps when timestamps are not increasing', () => {
    const frames = [mockFrame(0), mockFrame(0), mockFrame(0)];

    expect(deriveGifFrameDelays(frames, 10)).toEqual([10, 10, 10]);
  });

  it('encodes a gif that can be parsed and lzw-decoded', async () => {
    const width = 2;
    const height = 2;
    const frame1 = createMockCanvas(width, height, [
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 0, 255,
    ]);
    const frame2 = createMockCanvas(width, height, [
      0, 0, 0, 0,
      255, 255, 255, 255,
      255, 0, 255, 255,
      0, 255, 255, 255,
    ]);

    const frames: ExtractedFrame[] = [
      { image: frame1, time: 0, label: '0' },
      { image: frame2, time: 0.1, label: '0.1' },
    ];

    const blob = await buildAnimatedGif(frames, {
      fps: 10,
      transparent: true,
    });
    const bytes = new Uint8Array(await readBlobAsArrayBuffer(blob));
    const parsed = parseGif(bytes);

    expect(parsed.header).toBe('GIF89a');
    expect(parsed.width).toBe(width);
    expect(parsed.height).toBe(height);
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames.every((frame) => frame.pixelCount === width * height)).toBe(true);
  });

  it('encodes a larger colorful gif stream', async () => {
    const width = 64;
    const height = 64;
    const rgba: number[] = [];

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        rgba.push((x * 13) % 256, (y * 17) % 256, ((x + y) * 19) % 256, (x + y) % 7 === 0 ? 0 : 255);
      }
    }

    const frames: ExtractedFrame[] = [
      { image: createMockCanvas(width, height, rgba), time: 0, label: '0' },
      { image: createMockCanvas(width, height, rgba.slice().reverse()), time: 0.08, label: '0.08' },
    ];

    const blob = await buildAnimatedGif(frames, {
      fps: 12,
      transparent: true,
    });
    const bytes = new Uint8Array(await readBlobAsArrayBuffer(blob));
    const parsed = parseGif(bytes);

    expect(parsed.header).toBe('GIF89a');
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames.every((frame) => frame.pixelCount === width * height)).toBe(true);
  });
});

function createMockCanvas(
  width: number,
  height: number,
  rgba: number[],
): HTMLCanvasElement {
  const data = new Uint8ClampedArray(rgba);
  const context = {
    getImageData: () => ({ data }),
  } as unknown as CanvasRenderingContext2D;

  return {
    width,
    height,
    getContext: (type: string) => (type === '2d' ? context : null),
  } as unknown as HTMLCanvasElement;
}

function parseGif(bytes: Uint8Array): {
  header: string;
  width: number;
  height: number;
  frames: Array<{ pixelCount: number }>;
} {
  let offset = 0;

  function readByte(): number {
    const value = bytes[offset];
    offset += 1;
    return value ?? 0;
  }

  function readShort(): number {
    const left = readByte();
    const right = readByte();
    return left | (right << 8);
  }

  function readSubBlocks(): Uint8Array {
    const chunks: number[] = [];
    while (true) {
      const size = readByte();
      if (size === 0) {
        break;
      }

      for (let index = 0; index < size; index += 1) {
        chunks.push(readByte());
      }
    }

    return Uint8Array.from(chunks);
  }

  const header = String.fromCharCode(...bytes.slice(0, 6));
  offset = 6;
  const width = readShort();
  const height = readShort();
  const packed = readByte();
  readByte();
  readByte();

  if ((packed & 0x80) !== 0) {
    const gctSize = 1 << ((packed & 0x07) + 1);
    offset += gctSize * 3;
  }

  const frames: Array<{ pixelCount: number }> = [];

  while (offset < bytes.length) {
    const marker = readByte();

    if (marker === 0x3b) {
      break;
    }

    if (marker === 0x21) {
      readByte();
      readSubBlocks();
      continue;
    }

    if (marker !== 0x2c) {
      throw new Error(`unexpected marker: ${marker}`);
    }

    readShort();
    readShort();
    const imageWidth = readShort();
    const imageHeight = readShort();
    const imagePacked = readByte();

    if ((imagePacked & 0x80) !== 0) {
      const lctSize = 1 << ((imagePacked & 0x07) + 1);
      offset += lctSize * 3;
    }

    const lzwMinCodeSize = readByte();
    const lzwData = readSubBlocks();
    const decoded = decodeLzw(lzwData, lzwMinCodeSize);
    frames.push({ pixelCount: decoded.length });

    if (decoded.length < imageWidth * imageHeight) {
      throw new Error('decoded pixels are shorter than expected');
    }
  }

  return {
    header,
    width,
    height,
    frames,
  };
}

function decodeLzw(data: Uint8Array, minCodeSize: number): number[] {
  let bitOffset = 0;

  function readCode(codeSize: number): number | null {
    let value = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const byteIndex = Math.floor((bitOffset + bit) / 8);
      const bitIndex = (bitOffset + bit) % 8;
      const byte = data[byteIndex];
      if (byte === undefined) {
        return null;
      }

      value |= ((byte >> bitIndex) & 1) << bit;
    }

    bitOffset += codeSize;
    return value;
  }

  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const output: number[] = [];
  let codeSize = minCodeSize + 1;
  let dictionary = Array.from({ length: clearCode }, (_, index) => [index]);
  dictionary.push([]);
  dictionary.push([]);
  let previous: number[] | null = null;

  while (true) {
    const code = readCode(codeSize);
    if (code === null) {
      break;
    }

    if (code === clearCode) {
      dictionary = Array.from({ length: clearCode }, (_, index) => [index]);
      dictionary.push([]);
      dictionary.push([]);
      codeSize = minCodeSize + 1;
      previous = null;
      continue;
    }

    if (code === endCode) {
      break;
    }

    let entry = dictionary[code];
    if (!entry) {
      if (!previous) {
        throw new Error('invalid lzw stream: missing previous entry');
      }

      entry = [...previous, previous[0] ?? 0];
    }

    output.push(...entry);

    if (previous) {
      const next = [...previous, entry[0] ?? 0];
      dictionary.push(next);
      if (dictionary.length === 1 << codeSize && codeSize < 12) {
        codeSize += 1;
      }
    }

    previous = entry;
  }

  return output;
}

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(new Error('failed to read blob'));
    };

    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }

      reject(new Error('blob result is not ArrayBuffer'));
    };

    reader.readAsArrayBuffer(blob);
  });
}
