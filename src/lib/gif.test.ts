import { describe, expect, it } from 'vitest';
import type { ExtractedFrame } from '../types';
import { deriveGifFrameDelays } from './gif';

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
});
