import { describe, expect, it } from 'vitest';
import type { ExtractedFrame, SpineDraft, SpineExportOptions } from '../types';
import {
  buildSpineReadme,
  buildSpineSkeletonData,
  getSpineFrameFileName,
  getSpineJsonFileName,
  getSpineZipFileName,
} from './spineBundle';

const frames = [{}, {}, {}] as ExtractedFrame[];

const draft: SpineDraft = {
  frames,
  baseName: 'demo clip.mov',
  width: 128,
  height: 128,
  transparent: true,
};

const options: SpineExportOptions = {
  skeletonName: 'demo',
  animationName: 'idle',
  slotName: 'sprite',
  fps: 12,
};

describe('spine bundle helpers', () => {
  it('creates spine export file names', () => {
    expect(getSpineJsonFileName('demo clip.mov')).toBe('demo-clip-spine.json');
    expect(getSpineZipFileName('demo clip.mov')).toBe('demo-clip-spine.zip');
    expect(getSpineFrameFileName('demo clip.mov', 1)).toBe('images/demo-clip-spine-002.png');
  });

  it('creates a skeleton JSON with bones, slots, skins and animations', () => {
    const json = buildSpineSkeletonData(draft, options);

    expect(json.skeleton.name).toBe('demo');
    expect(json.bones).toEqual([{ name: 'root' }]);
    expect(json.slots).toEqual([
      {
        name: 'sprite',
        bone: 'root',
        attachment: 'demo-clip-spine-001',
      },
    ]);
    expect(json.skins[0]?.attachments.sprite['demo-clip-spine-001']).toEqual({
      type: 'region',
      path: 'images/demo-clip-spine-001',
      x: 0,
      y: 0,
      width: 128,
      height: 128,
    });
    expect(json.animations.idle.slots.sprite.attachment).toEqual([
      {
        time: 0.083333,
        name: 'demo-clip-spine-002',
      },
      {
        time: 0.166667,
        name: 'demo-clip-spine-003',
      },
    ]);
  });

  it('builds a readme with import hints and parameters', () => {
    const readme = buildSpineReadme(draft, options);

    expect(readme).toContain('Spine 动画导出说明');
    expect(readme).toContain('demo-clip-spine.json');
    expect(readme).toContain('fps: 12');
    expect(readme).toContain('transparent: yes');
  });
});
