import { describe, expect, it } from 'vitest';
import { BoxGeometry, DoubleSide, Mesh, MeshStandardMaterial, PointLight, Scene } from 'three';
import { VirtualPointLightGenerator } from './upstream/VirtualPointLightGenerator.js';

function enclosure(distance = 0) {
  const scene = new Scene();
  scene.add(new Mesh(new BoxGeometry(2, 2, 2), new MeshStandardMaterial({ color: 0xffffff, side: DoubleSide })));
  const light = new PointLight(0xffffff, 2, distance);
  scene.add(light);
  return { scene, light };
}

describe('multi-bounce VPL generation', () => {
  it('preserves source power across ray budgets and bounce depths', () => {
    const { scene, light } = enclosure();
    for (const [count, bounces] of [
      [128, 2],
      [512, 4],
    ] as const) {
      const generator = new VirtualPointLightGenerator(count).generate(scene, [light], { count, bounces, seed: 1 });
      expect(generator.count).toBe(count);
      const flux = generator.flux.slice(0, generator.count).reduce((sum, value) => sum + value.x, 0);
      expect(flux).toBeCloseTo(4 * Math.PI * light.intensity * bounces, 8);
    }
  });

  it('reproduces paths and never renormalizes escaped rays', () => {
    const { scene, light } = enclosure();
    const a = new VirtualPointLightGenerator(128).generate(scene, [light], { count: 128, bounces: 2, seed: 7 });
    const b = new VirtualPointLightGenerator(128).generate(scene, [light], { count: 128, bounces: 2, seed: 7 });
    expect(a.positions).toEqual(b.positions);
    expect(a.flux).toEqual(b.flux);
    scene.remove(scene.children[0]!);
    a.generate(scene, [light], { count: 128, bounces: 2 });
    expect(a.count).toBe(0);
  });

  it('matches finite point-light attenuation and carries it through later bounces', () => {
    const { scene, light } = enclosure(3);
    const limited = new VirtualPointLightGenerator(128).generate(scene, [light], { count: 128, bounces: 2 });
    light.distance = 0;
    const unlimited = new VirtualPointLightGenerator(128).generate(scene, [light], { count: 128, bounces: 2 });
    for (let i = 0; i < limited.count; i++) {
      const firstHit = i - (i % 2);
      const distance = limited.positions[firstHit]!.length();
      const attenuation = Math.max(0, 1 - (distance / 3) ** 4) ** 2;
      expect(limited.flux[i]!.x / unlimited.flux[i]!.x).toBeCloseTo(attenuation, 10);
    }
  });
});
