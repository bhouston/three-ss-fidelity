import { beforeEach, expect, it, vi } from 'vitest';
import { NoToneMapping, PerspectiveCamera, Scene, Vector3 } from 'three';
import type { SceneSetup } from '@ss-fidelity/scenes';
import { createThreeNewRenderer } from './three-new.js';
import { hierarchyExperiments, ssgiWorkExperiments } from './types.js';
import { ssgi } from './ssgi-fast/SSGINode.js';
import { newSSR } from './ssr/NewSSRNode.js';

// Build the real TSL graph without a GPU, and inspect the actual nodes and owned targets.
const state = vi.hoisted(() => ({ targets: [] as { dispose(): void }[] }));
vi.mock('three/webgpu', async (original) => ({
  ...(await original<typeof import('three/webgpu')>()),
  WebGPURenderer: class {
    shadowMap = { enabled: false };
    async init() {}
    dispose() {}
  },
  RenderPipeline: class {
    set rttDisposables(targets: typeof state.targets) {
      state.targets = targets;
    }
    get rttDisposables() {
      return state.targets;
    }
    dispose() {}
  },
}));
vi.mock('./helpers.js', () => ({
  configureRenderer: vi.fn(),
  prepareScene: () => () => {},
  setRenderSize: vi.fn(),
}));
vi.mock('./ssgi-fast/SSGINode.js', async (original) => {
  const actual = await original<{ ssgi: typeof ssgi }>();
  return { ...actual, ssgi: vi.fn(actual.ssgi) };
});
vi.mock('./ssr/NewSSRNode.js', async (original) => {
  const actual = await original<{ newSSR: typeof newSSR }>();
  return { ...actual, newSSR: vi.fn(actual.newSSR) };
});
beforeEach(() => vi.clearAllMocks());

function setup(scale = 1, gi = true, ssr = true): SceneSetup {
  return {
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    target: new Vector3(),
    effects: {
      frames: 128,
      toneMapping: NoToneMapping,
      toneMappingExposure: 1,
      resolutionScale: scale,
      temporalDenoise: false,
      ...(gi ? { ssgi: { sliceCount: 2, stepCount: 8, giIntensity: 1 } } : {}),
      ...(ssr ? { ssr: { maxDistance: 20 } } : {}),
    },
  };
}

it('combines all three techniques while preserving the independent profiles', async () => {
  for (const experiment of hierarchyExperiments) {
    vi.clearAllMocks();
    const live = await createThreeNewRenderer({} as HTMLCanvasElement, setup(), {
      width: 161,
      height: 121,
      hierarchyExperiment: experiment,
    });
    const gi = vi.mocked(ssgi).mock.results[0]!.value;
    const reflections = vi.mocked(newSSR).mock.results[0]!.value;
    const combined = experiment === 'hierarchy-combined' || Object.hasOwn(ssgiWorkExperiments, experiment);
    expect(gi.radianceMips).toBe(combined || experiment === 'ssgi-radiance-mips');
    expect(reflections._tightHiZ).toBe(combined || experiment === 'ssr-hiz-tight');
    expect(reflections._radianceMipNode !== null).toBe(combined || experiment === 'ssr-radiance-mips');
    if (combined) {
      expect(reflections._radianceMipNode).toBe(gi.beautyNode);
      expect(gi.beautyNode.value.generateMipmaps).toBe(true);
      // Perfect mirrors and secondary bounces retain the original, unquantized history source.
      expect(reflections.colorNode).not.toBe(gi.beautyNode);
    }
    expect(state.targets).toHaveLength(experiment === 'ssr-radiance-mips' ? 2 : 1);
    const disposals = state.targets.map((target) => vi.spyOn(target, 'dispose'));
    live.dispose();
    disposals.forEach((dispose) => expect(dispose).toHaveBeenCalledTimes(1));
  }
});

it('keeps full-resolution SSR radiance when GI renders at half resolution', async () => {
  const live = await createThreeNewRenderer({} as HTMLCanvasElement, setup(0.5), {
    width: 161,
    height: 121,
    hierarchyExperiment: 'hierarchy-combined',
  });
  const gi = vi.mocked(ssgi).mock.results[0]!.value;
  const reflections = vi.mocked(newSSR).mock.results[0]!.value;
  expect(state.targets).toHaveLength(2);
  expect(reflections._radianceMipNode).not.toBe(gi.beautyNode);
  expect(gi.beautyNode.getResolutionScale()).toBe(0.5);
  expect(reflections._radianceMipNode.getResolutionScale()).toBe(1);
  live.dispose();
});

it.each([
  [true, false],
  [false, true],
])('builds only the needed source with GI=%s SSR=%s', async (gi, ssr) => {
  const live = await createThreeNewRenderer({} as HTMLCanvasElement, setup(1, gi, ssr), {
    width: 161,
    height: 121,
    hierarchyExperiment: 'hierarchy-combined',
  });
  expect(state.targets).toHaveLength(1);
  expect(ssgi).toHaveBeenCalledTimes(gi ? 1 : 0);
  expect(newSSR).toHaveBeenCalledTimes(ssr ? 1 : 0);
  live.dispose();
});

it('scales scene sample budgets independently and keeps work flags opt-in', async () => {
  const expected = [
    ['hierarchy-combined', 8, 32, false, false],
    ['ssgi-early-exit', 8, 32, true, false],
    ['ssgi-reuse-texels', 8, 32, false, true],
    ['ssgi-redundant-work', 8, 32, true, true],
    ['ssgi-4x32', 4, 32, false, false],
    ['ssgi-8x16', 8, 16, false, false],
    ['ssgi-4x16', 4, 16, false, false],
    ['ssgi-2x16', 2, 16, false, false],
    ['ssgi-2x8', 2, 8, false, false],
    ['ssgi-6x32', 6, 32, false, false],
    ['ssgi-8x24', 8, 24, false, false],
    ['ssgi-6x24', 6, 24, false, false],
    ['ssgi-7x32', 7, 32, false, false],
    ['ssgi-8x28', 8, 28, false, false],
  ] as const;
  for (const [experiment, slices, steps, earlyExit, reuse] of expected) {
    vi.clearAllMocks();
    const scene = setup();
    scene.effects.ssgi!.sliceCount = 8;
    scene.effects.ssgi!.stepCount = 32;
    const live = await createThreeNewRenderer({} as HTMLCanvasElement, scene, {
      width: 160,
      height: 120,
      hierarchyExperiment: experiment,
    });
    const gi = vi.mocked(ssgi).mock.results[0]!.value;
    expect([gi.sliceCount.value, gi.stepCount.value, gi.earlyExit, gi.reuseDuplicateTexels]).toEqual([
      slices,
      steps,
      earlyExit,
      reuse,
    ]);
    expect(scene.effects.ssgi!.sliceCount).toBe(8);
    expect(scene.effects.ssgi!.stepCount).toBe(32);
    live.dispose();
  }
  vi.clearAllMocks();
  const scene = setup();
  scene.effects.ssgi!.sliceCount = 1;
  scene.effects.ssgi!.stepCount = 1;
  const live = await createThreeNewRenderer({} as HTMLCanvasElement, scene, {
    width: 160,
    height: 120,
    hierarchyExperiment: 'ssgi-2x8',
  });
  const gi = vi.mocked(ssgi).mock.results[0]!.value;
  expect([gi.sliceCount.value, gi.stepCount.value]).toEqual([1, 1]);
  live.dispose();
});
