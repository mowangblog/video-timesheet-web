import { describe, expect, it } from 'vitest';
import { getLayoutMetrics, getSheetAppearance } from './sheet';
import type { SheetOptions, VideoMeta } from '../types';

const meta: VideoMeta = {
  duration: 12,
  width: 1920,
  height: 1080,
  name: 'sample.mp4',
};

const options: SheetOptions = {
  columns: 4,
  gap: 8,
  backgroundColor: '#ffffff',
};

describe('getLayoutMetrics', () => {
  it('calculates sheet size without timestamps', () => {
    expect(getLayoutMetrics(meta, 12, options, false)).toEqual({
      rows: 3,
      canvasWidth: 1304,
      canvasHeight: 556,
      frameWidth: 320,
      frameHeight: 180,
      labelBlockHeight: 0,
    });
  });

  it('adds extra height when timestamps are enabled', () => {
    expect(getLayoutMetrics(meta, 12, options, true)).toEqual({
      rows: 3,
      canvasWidth: 1304,
      canvasHeight: 706,
      frameWidth: 320,
      frameHeight: 180,
      labelBlockHeight: 30,
    });
  });

  it('uses a transparent appearance for transparent exports', () => {
    expect(getSheetAppearance(true)).toEqual({
      transparentBackground: true,
      showCardBackground: false,
    });
  });

  it('uses exact sprite frame size when export preset is set', () => {
    expect(
      getLayoutMetrics(meta, 12, {
        ...options,
        frameSize: 64,
      }, false),
    ).toEqual({
      rows: 3,
      canvasWidth: 280,
      canvasHeight: 208,
      frameWidth: 64,
      frameHeight: 64,
      labelBlockHeight: 0,
    });
  });
});
