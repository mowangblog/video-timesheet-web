import { describe, expect, it } from 'vitest';
import { getCropBounds, getSampleTimes, normalizeCropArea } from './video';

describe('getSampleTimes', () => {
  it('returns evenly spaced timestamps based on frames per second', () => {
    const samples = getSampleTimes(10, 4);

    expect(samples).toHaveLength(39);
    expect(samples[0]).toBe(0.2);
    expect(samples[samples.length - 1]).toBe(9.8);
  });

  it('returns samples only inside the selected segment', () => {
    const samples = getSampleTimes(10, 2, 2, 6);

    expect(samples).toHaveLength(8);
    expect(samples[0]).toBe(2.2);
    expect(samples[samples.length - 1]).toBe(5.8);
  });

  it('returns a single midpoint when the segment is shorter than one interval', () => {
    expect(getSampleTimes(9, 1, 2, 2.3)).toEqual([2.15]);
  });

  it('returns empty array when inputs are invalid', () => {
    expect(getSampleTimes(0, 4, 0, 1)).toEqual([]);
    expect(getSampleTimes(10, 0, 0, 1)).toEqual([]);
  });
});

describe('normalizeCropArea', () => {
  it('returns full frame when crop area is missing', () => {
    expect(normalizeCropArea()).toEqual({
      leftPercent: 0,
      topPercent: 0,
      widthPercent: 100,
      heightPercent: 100,
    });
  });

  it('clamps out-of-range values and prevents overflow', () => {
    expect(
      normalizeCropArea({
        leftPercent: 88,
        topPercent: -3,
        widthPercent: 50,
        heightPercent: 300,
      }),
    ).toEqual({
      leftPercent: 88,
      topPercent: 0,
      widthPercent: 12,
      heightPercent: 100,
    });
  });
});

describe('getCropBounds', () => {
  it('converts crop percentages into pixel bounds', () => {
    expect(
      getCropBounds(1920, 1080, {
        leftPercent: 10,
        topPercent: 20,
        widthPercent: 50,
        heightPercent: 50,
      }),
    ).toEqual({
      x: 192,
      y: 216,
      width: 960,
      height: 540,
    });
  });
});
