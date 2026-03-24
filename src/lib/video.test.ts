import { describe, expect, it } from 'vitest';
import { getSampleTimes } from './video';

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
