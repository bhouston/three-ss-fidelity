import { expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, PlaneGeometry, Texture, WebGPUCoordinateSystem, WGSLNodeBuilder } from 'three/webgpu';
import { float, texture, uniform } from 'three/tsl';
import NewSSRNode from './ssr/NewSSRNode.js';

// Three's public typings omit builder internals. These are the actual WGSL
// builder methods; the renderer fixture supplies only device-independent state.
interface ShaderBuilder {
  shaderStage: string;
  flowStagesNode(node: unknown, output: string): { code: string };
  codes: { fragment: { code: string }[] };
  uniforms: { fragment: { name: string; node: unknown }[] };
  structs: { fragment: { name: string }[] };
}

const textureNode = () => texture(new Texture());

function createFixture() {
  const renderer = {
    backend: { utils: { getTextureSampleData: () => ({ primarySamples: 1 }) } },
    debug: { diagnostics: { keywords: false } },
    coordinateSystem: WebGPUCoordinateSystem,
    logarithmicDepthBuffer: false,
    hasFeature: () => false,
  };
  const depthTexture = new Texture();
  const options = {
    camera: new PerspectiveCamera(),
    stochastic: true,
    outputRadiance: true,
    binaryRefine: true,
    roughnessNode: float(0.2),
    metalnessNode: float(1),
    hitMaterialNode: textureNode(),
    hitSpecularNode: textureNode(),
    secondBounceQuality: 0.35,
  };
  const ssr = new NewSSRNode(textureNode(), texture(depthTexture), textureNode(), options);
  ssr.radianceHistoryNode = textureNode();
  const geometry = new PlaneGeometry();
  const createBuilder = () => {
    const builder = new WGSLNodeBuilder(new Mesh(geometry), renderer as never) as unknown as ShaderBuilder;
    builder.shaderStage = 'fragment';
    return builder;
  };
  const builder = createBuilder();
  ssr.setup(builder);
  const material = (ssr as unknown as { _ssrMaterial: { fragmentNode: unknown } })._ssrMaterial;
  const generate = (target: ShaderBuilder) => {
    const main = target.flowStagesNode(material.fragmentNode, 'vec4').code;
    const functions = target.codes.fragment.map((entry) => entry.code).join('\n');
    return { main, functions };
  };
  return {
    ssr,
    depthTexture,
    builder,
    createBuilder,
    generate,
    dispose() {
      ssr.dispose();
      geometry.dispose();
    },
  };
}

it('emits one SSR trace and GGX sampler for two reflection bounces with independent march quality', () => {
  const fixture = createFixture();
  try {
    const { main, functions } = fixture.generate(fixture.builder);
    expect(functions.match(/\bfn ssrTrace\s*\(/g)).toHaveLength(1);
    expect(functions.match(/\bfn ssrSampleReflection\s*\(/g)).toHaveLength(1);
    expect(main.match(/\bssrTrace\(/g)).toHaveLength(2);
    expect(main.match(/\bssrSampleReflection\(/g)).toHaveLength(2);
    expect(functions).toMatch(/marchQuality : f32, traceMultiplier : i32\s*\) -> SSRTraceResult/);
    const calls = main.split('\n').filter((line) => line.includes('ssrTrace('));
    expect(calls[0]).toMatch(/clamp\( object\.nodeUniform\d+, 0\.0, 1\.0 \)/);
    expect(calls[1]).toContain('clamp( 0.35, 0.0, 1.0 )');
  } finally {
    fixture.dispose();
  }
});

it('rebuilds captured SSR bindings and result types when the same material graph compiles again', () => {
  const fixture = createFixture();
  try {
    const first = fixture.generate(fixture.builder);
    const secondBuilder = fixture.createBuilder();
    // Deliberately shift binding allocation in the second builder. Reusing the
    // first layout function's cached WGSL would reference the wrong uniform.
    secondBuilder.flowStagesNode(uniform(7), 'float');
    const second = fixture.generate(secondBuilder);
    expect(second.functions).not.toEqual(first.functions);
    for (const builder of [fixture.builder, secondBuilder]) {
      const maxDistance = builder.uniforms.fragment.find((entry) => entry.node === fixture.ssr.maxDistance);
      expect(maxDistance).toBeDefined();
      const functions = builder.codes.fragment.map((entry) => entry.code).join('\n');
      const trace = functions.slice(functions.indexOf('fn ssrTrace '));
      expect(trace).toContain(`object.${maxDistance!.name}`);
      const declared = new Set(builder.uniforms.fragment.map((entry) => entry.name));
      for (const reference of functions.matchAll(/\b(nodeUniform\d+)\b/g)) {
        expect(declared.has(reference[1]!)).toBe(true);
      }
      expect(
        builder.uniforms.fragment.some((entry) => (entry.node as { value?: unknown }).value === fixture.depthTexture),
      ).toBe(true);
      expect(builder.structs.fragment.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(['SSRTraceResult', 'SSRReflectionSample']),
      );
    }
  } finally {
    fixture.dispose();
  }
});
