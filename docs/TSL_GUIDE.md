# Writing compact, efficient TSL shaders

TSL JavaScript constructs a graph that Three.js turns into WGSL or GLSL. GPU execution happens later. Make performance decisions by inspecting that generated shader and measuring the relevant stage: short JavaScript does not necessarily produce a small shader, and a smaller shader does not necessarily run faster.

This guide describes the Three.js fork pinned by this repository. The [official TSL reference](https://threejs.org/docs/pages/TSL.html) and [TSL specification](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language) are useful API references; check the pinned source when behavior or portability matters.

## JavaScript builds the graph; TSL controls the shader

A JavaScript loop inside `Fn` executes while the graph is built. It constructs a copy of the body for each iteration:

```js
const gather = Fn(([center]) => {
  const sum = vec3(0).toVar();
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      sum.addAssign(sampleAt(center.add(vec2(x, y))));
    }
  }
  return sum.div(9);
});
```

The generated shader contains nine sampling bodies. If each sample expands into reconstruction, filtering, or BRDF work, the growth can be substantial. Use TSL `Loop` when iteration should happen on the GPU:

```js
const gather = Fn(([center]) => {
  const sum = vec3(0).toVar();
  Loop(
    { start: -1, end: 1, condition: '<=', name: 'x' },
    { start: -1, end: 1, condition: '<=', name: 'y' },
    ({ x, y }) => {
      sum.addAssign(sampleAt(center.add(vec2(x, y))));
    },
  );
  return sum.div(9);
});
```

This emits nested shader loops with one copy of the sample body. The shader compiler may subsequently unroll them, but Three.js no longer hands it nine expanded copies. The compact `Loop(count, ({ i }) => ...)` form starts at zero and uses an exclusive upper bound. Use explicit names when nesting helpers to avoid accidentally sharing loop identifiers. `Break()` exits the innermost loop; `Continue()` advances it. Put runtime tests inside TSL `If`:

```js
Loop({ start: 0, end: maxSteps, name: 'step' }, ({ step }) => {
  const candidate = marchStep(step).toVar();
  If(candidate.get('outside'), () => {
    Break();
  });
  If(candidate.get('invalid'), () => {
    Continue();
  });
  accumulated.addAssign(candidate.get('radiance'));
});
```

The example assumes `marchStep` returns a TSL struct with `outside`, `invalid`, and `radiance` members. Access shader struct members with `.get('memberName')`. A JavaScript `if` tests a host value; it cannot test a GPU node's value. `if (this.useHiZ)` is appropriate when choosing a shader variant during setup. `If(depth.greaterThan(limit), ...)` is appropriate for a per-pixel decision. [LoopNode documentation](https://threejs.org/docs/pages/LoopNode.html) describes the supported loop forms and control operations.

Keep JavaScript loops when they deliberately generate a small, fixed expression or different specialized operations. For example, constructing an eight-entry offset table with `offsets.map(...)` is useful; iterate that table with shader `Loop` when each entry performs the same expensive operation. A tiny constant swizzle or two independent channels may compile better when expanded. Measure rather than replacing every host loop mechanically.

Preserve traversal and accumulation order when converting loops. Floating-point addition is order-sensitive, and an equal-depth tie can select a different neighbor if x-major traversal becomes y-major. For nonrectangular neighborhoods, retain the original offset order in a shader array and iterate its indices.

## Materialize expensive values at the scope where they are reused

JavaScript `const` fixes a reference to a node, not the GPU result of that node:

```js
const reconstructed = reconstructPosition(uv, depth);
```

The graph builder can cache repeated node uses automatically. In this fork, [Node.js](../submodules/three.js/src/nodes/core/Node.js) tracks usage and emits temporaries for eligible nodes referenced more than once. That does not establish a universal guarantee that arbitrary equivalent expressions or uses across branches become a single evaluation.

Use `.toVar()` to make a shader variable when the value is mutated or when evaluation scope matters:

```js
const position = reconstructPosition(uv, depth).toVar();
const sum = vec3(0).toVar();
Loop(sampleCount, ({ i }) => {
  sum.addAssign(sampleLighting(position, i));
});
```

The position is loop-invariant and belongs before the loop. In contrast, the value of `sampleLighting(position, i)` depends on the iteration and must remain in the loop. Reusing the same expression object helps caching; rebuilding equivalent graphs in separate helper calls can defeat it.

Use `.toConst()` for a shader-local value that will never be assigned again:

```js
const mean = sum.div(sampleCount).toConst();
const variance = secondMoment.div(sampleCount).sub(mean.pow2()).max(0).toConst();
```

A TSL const can depend on uniforms, textures, or other runtime values. It means read-only shader storage, not necessarily a compile-time literal: this fork's [VarNode.js](../submodules/three.js/src/nodes/core/VarNode.js) selects backend declarations based on whether the initializer is deterministic. GLSL and WGSL declarations need not have identical syntax.

Prefer materialization for expensive reused samples, reconstruction results, and values reused across branches. Do not add variables to every arithmetic operation: the builder already caches many nodes, variables can increase live ranges, and the driver may optimize the expression better itself.

For branches, place materialization deliberately. Computing a value before `If` guarantees both branches can use it, but also performs the work when neither needs it. Computing it inside a branch keeps it conditional. Inspect the generated scope and compare outputs when moving it: this is an evaluation-order change as well as a source-size change.

In TRAA we materialize the center texel before the depth and variance neighborhoods. The prior generated shader first assigned the UV × texture-dimensions expression inside the nested depth loop. This is a useful invariant to hoist even though it does not create a large source-size saving.

## `Fn` organizes expressions; layouts emit shader functions

An ordinary `Fn` helps author a TSL graph. Without a layout, its body can be expanded at every call site. Calling the same JavaScript helper twice does not inherently produce one WGSL function.

Use `.setLayout()` for a substantial helper whose body should be shared:

```js
const evaluateFalloff = Fn(([distance, radius]) => {
  const normalized = distance.div(radius.max(1e-4)).toConst();
  return normalized.oneMinus().max(0).pow2();
}).setLayout({
  name: 'evaluateFalloff',
  type: 'float',
  inputs: [
    { name: 'distance', type: 'float' },
    { name: 'radius', type: 'float' },
  ],
});
```

The signature uses shader types (`float`, `int`, `uint`, `bool`, `vec2`, `vec3`, `vec4`, matrices), and every call supplies the matching arguments. This emits one typed shader function and calls it within the shader. Each separately compiled shader still contains the helpers it uses; this does not create a shared GPU library across pipelines. The fork implements the distinction in [TSLCore.js](../submodules/three.js/src/nodes/tsl/TSLCore.js).

For several outputs, define a named struct and match its name in the return layout:

```js
const Hit = struct({ found: 'bool', uv: 'vec2', depth: 'float' }, 'MyTraceHit');
const trace = Fn(([origin, direction]) => {
  // ... shader tracing and result variables ...
  return Hit({ found, uv: hitUV, depth: hitDepth });
}).setLayout({
  name: 'myTrace',
  type: 'MyTraceHit',
  inputs: [
    { name: 'origin', type: 'vec3' },
    { name: 'direction', type: 'vec3' },
  ],
});
const hit = trace(origin, direction).toVar();
const hitUV = hit.get('uv');
```

This is a signature sketch, with tracing omitted. Materialize a reused returned struct so reading several fields does not issue repeated function calls. Use a distinct stable struct name when the layout needs to refer to that type.

Do not convert every helper. A single call site offers no body deduplication and may add declarations and call overhead. A tiny helper called twice may still be cheaper inline. Resource arguments require particular care: ordinary JavaScript texture-node objects are not interchangeable with scalar/vector layout inputs, and texture/sampler signatures vary by backend. In this project, resource-dependent helpers can capture their material's textures instead of pretending they are primitive arguments.

### Captures and function caching

This fork's [NodeBuilder.buildFunctionNode](../submodules/three.js/src/nodes/core/NodeBuilder.js) caches generated functions by renderer backend and shader-node identity. A reusable function that closes over builder-assigned uniforms or textures can therefore retain generated binding names from its first build when reused by another material.

Create such a layout helper on every graph build, and pass call-dependent values explicitly. Creating it only during material setup is insufficient when the same material graph can compile again: the cached function may still contain the first builder's binding names. Define the helper inside the outer graph-building `Fn` so each builder gets a fresh helper identity. SSR's tracing helper is created inside the SSR graph build for this reason. Its ray position, direction, UV, jitter, quality, and metalness-derived trace multiplier are explicit inputs; material textures and configuration stay associated with that build. Pure arithmetic helpers with only explicit arguments are easier to share globally.

When changing a helper, test multiple material instances and variants on the same renderer, and compile the same stored material graph with two builders. Deliberately shift the second builder's binding allocation to catch stale binding references. [shader-functions.test.ts](../packages/renderers/src/shader-functions.test.ts) exercises that case using the actual SSR graph without a GPU. A function that compiles once can still reference the wrong bindings when cached elsewhere.

## What this project's audit found

- SSR's primary and secondary rays had duplicated tracing/refinement bodies and duplicated GGX sampling logic. Typed trace and reflection-sample functions share those bodies. The [shader-function audit](history/SHADER_FUNCTIONS.md) records generated source sizes, configuration, image comparisons, and timing results.
- SSGI's sector-bitfield calculation now has a layout function; its spatial-offset and fast-acos helpers already used layouts. Main sampling loops already use TSL loops.
- TRAA already had reusable `clipAABB`, `flickerReduction`, and `subpixelCorrection` functions. Its current/previous depth and variance helpers each have one call site, so further layouts do not remove repeated bodies.
- AO and GI come from the same SSGI sampling pass through multiple render targets. The shared sector-bitfield helper therefore applies to both outputs; there is no separate AO trace shader to factor in this pipeline. A helper used once inside a runtime loop already contributes one emitted body, regardless of how many times that loop executes.

These observations are about the audited shader variants, not every possible combination of renderer settings. Shader bytes and function counts are evidence about emitted code; they are not runtime benchmarks.

## Validate the shader and measure the right stage

Use [scripts/shader-audit.mjs](../scripts/shader-audit.mjs) and [scripts/shader-audit-browser.mjs](../scripts/shader-audit-browser.mjs) to capture generated code. Their usage comments describe the required build and output directory. The earlier [shader code-size audit](history/SHADER_CODE_SIZE.md) and [shader-function audit](history/SHADER_FUNCTIONS.md) show how to report changes. Check loops, function definitions, call sites, declaration counts, repeated long expressions, and scopes. Verify sampled/reconstructed values are materialized where intended. Compare screenshots or numerical image differences with the same scene and settings, including secondary bounces, history, depth modes, and supported backends affected by the change.

Separate graph construction, shader generation, shader-module validation, pipeline creation, first render, asset loading, and steady-state GPU execution. A wrapper's wall-clock time includes the work inside that wrapper; it does not automatically identify which compiler stage dominates. Asynchronous pipeline creation can overlap other work, and driver caches can make a repeat run much faster than a cold run.

Smaller generated shaders can reduce parser and compiler input. Drivers may inline layout functions or unroll loops again while optimizing, so backend optimization time and GPU instruction count can behave differently. More functions can even expose additional specialization work. Report repeated measurements with configuration, backend, warm/cold conditions, sample count, and dispersion. Claim runtime improvement only with appropriate GPU timing or a controlled steady-state benchmark.

## Control shader variants as well as body size

A host constant can produce a different shader for each setting, even when almost all source is identical. Our Hi-Z reduction levels 1–6 bake different mip literals into otherwise identical bodies and create six pipelines. Together they cost about 0.55–0.66 seconds in fresh native captures. A shared mip-level uniform is a useful candidate when it preserves texture/view semantics and does not compromise GPU optimization. Keep host specialization when it removes substantial work or is required by an API; use uniforms for runtime values that need not change source.

Profile before attributing a startup pause to your largest shader. In these captures, 25 first-frame native pipelines cost 3.16–3.77 seconds while TSL builders cost 0.086–0.099 seconds. SSR was the largest single pipeline, but many smaller shaders also contributed. Chromium deferred work past its pipeline calls. The [startup report](history/SHADER_STARTUP.md) explains the timing boundaries, opt-in instrumentation commands, cache controls and the reproduced native GPU timestamp limitation.
