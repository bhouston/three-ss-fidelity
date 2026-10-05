# Upstream proposal: SSGINode AO never reaches 1 on flat surfaces

This is a proposed fix to `examples/jsm/tsl/display/SSGINode.js` in three.js (mrdoob/three.js `dev`). The fork already
has it as commit [`83c310af72`](https://github.com/bhouston/three.js/commit/83c310af72715ae558beea12d169f00c62ea48eb)
on `ssgi-traa-redesign`. ss-fidelity adopted it in #50 (issue #49). It changes only the bitmask sector count.

## Problem

In SSGINode's AO output, an unoccluded flat surface doesn't come out at 1.0. It sits at about 0.82–0.94, while the
path-traced reference is white. This isn't caused by tone mapping or color space: in ss-fidelity the AO pass is
written linear with `NoToneMapping` and `aoIntensity` 1.

## Cause

SSGINode uses visibility-bitmask AO. Each slice's hemisphere is split into 32 sectors (`MAX_RAY`), and each horizon
sample marks the sectors it occludes:

```js
const startHorizonInt = uint(frontBackHorizon.mul(float(MAX_RAY))).toConst();
const angleHorizonInt = uint(ceil(maxHorizon.sub(minHorizon).mul(float(MAX_RAY)))).toConst();
```

A sample on the shading point's own tangent plane (any sample on a flat surface) has horizons exactly at the edge of
the hemisphere. Its interval `maxHorizon - minHorizon` should be 0, but in practice it's a small positive number:

- view positions are rebuilt from the depth buffer in float32;
- normals are packed (8-bit or half-float);
- `GTAOFastAcos` is used for the horizons, while the normal angle `n` uses an exact `acos` (up to 0.09 sector apart).

`ceil` turns any positive interval into a whole sector. Each slice can lose up to one sector per side, so up to 2/32
of the hemisphere. A CPU re-implementation of this code on an exact plane, in double precision, still gets a width of
4.6e-14 on some steps and marks the sector. On the GPU, with real depth and normal error, this happens most of the time.

`ceil` also over-counts real occluders by half a sector on average, and `floor` on the start can shift the marked
range by up to one sector.

## Fix

Count a sector as occluded when its center lies between the two horizons: round both ends and take the difference.

```diff
-import { ..., div, ceil, shiftRight, ... } from 'three/tsl';
+import { ..., div, round, shiftRight, ... } from 'three/tsl';

-const startHorizonInt = uint( frontBackHorizon.mul( float( MAX_RAY ) ) ).toConst();
-const angleHorizonInt = uint( ceil( maxHorizon.sub( minHorizon ).mul( float( MAX_RAY ) ) ) ).toConst();
+// a sector is occluded when its center lies between the horizons. Rounding both ends (instead of flooring the
+// start and taking the ceiling of the width) keeps a sample lying on the shading point's tangent plane, whose
+// horizon interval is zero up to depth/normal precision, from occluding a whole sector
+const startHorizon = round( minHorizon.mul( float( MAX_RAY ) ) ).toConst();
+const startHorizonInt = uint( startHorizon ).toConst();
+const angleHorizonInt = uint( max( round( maxHorizon.mul( float( MAX_RAY ) ) ).sub( startHorizon ), 0 ) ).toConst();
```

`ceil` was only used here, so its import is replaced. The `max( ..., 0 )` guards the `uint` conversion. A start of 32
only happens with a count of 0, which already selects an empty bitfield.

Alternatives considered:

- `ceil( width * 32 - ε )` with a small ε. This only removes noise-level widths, but ε then has to match depth and
  normal precision, which varies with view angle and buffer formats. `round` is the ε = 0.5 case of this.
- `round` on the width only, keeping `floor` on the start. This rounds inconsistently and can shift the range by up to
  a sector.

Occluders narrower than half a sector in a single sample are dropped. SSGINode jitters the slice angle and step offset
every frame, so they still contribute about the right amount once temporally accumulated.

## Evidence

Flat-plane simulation of the bitmask code (16 slices, 8 steps, samples exactly on the plane), AO before → after:

| Surface                | exact acos    | fast acos     | exact acos + 8-bit normal | fast acos + 8-bit normal |
| ---------------------- | ------------- | ------------- | ------------------------- | ------------------------ |
| floor, 30° grazing     | 0.951 → 1.000 | 0.969 → 1.000 | 0.969 → 1.000             | 0.969 → 1.000            |
| floor, 60°             | 0.941 → 1.000 | 0.969 → 1.000 | 0.969 → 1.000             | 0.969 → 1.000            |
| wall facing the camera | 1.000 → 1.000 | 1.000 → 1.000 | 0.969 → 1.000             | 0.969 → 1.000            |
| tilted wall            | 0.938 → 1.000 | 0.969 → 1.000 | 0.969 → 1.000             | 0.969 → 1.000            |

ss-fidelity AO pass, RMSE against three-gpu-pathtracer's ray-traced AO:

| Scene               | Before | After  |
| ------------------- | ------ | ------ |
| cornell-box-basic   | 0.1184 | 0.1056 |
| gltf-damaged-helmet | 0.1046 | 0.0880 |
| higharc_dogwood     | 0.1116 | 0.0960 |
| steampunk-camera    | 0.1378 | 0.1218 |
| gltf-coffeemat      | 0.1048 | 0.0939 |
| gltf-littlest-tokyo | 0.3236 | 0.3356 |

gltf-littlest-tokyo was already brighter than the reference, from missing occlusion elsewhere, so the fix moves it
slightly further away.

cornell-box-basic AO samples (7×7 means): the camera-facing back wall goes 0.929 → 0.988 (reference 0.980).

## Known side effects

- **GI gets slightly darker.** The GI term adds `numOccludedZones / 32 × light` per sample from the same bitfield, so
  the old over-count also added GI energy. In ss-fidelity's SSGI scenes the beauty was already darker than the
  reference, and its RMSE rises about 6 % (cornell-box-basic 0.0677 → 0.0720). The AO fix is still correct: it exposes a
  separate GI shortfall, tracked as #51, which should be fixed at its own source. The upstream PR should mention this
  so reviewers comparing the example screenshots aren't surprised.
- **Oblique surfaces are still dark.** Flat surfaces seen at an angle still sit about 0.1 low (cornell-box-basic side walls
  0.878 against 1.0). That has a different cause, tracked as #52, and is out of scope here.

## Upstream PR

- Branch from mrdoob/three.js `dev` and cherry-pick only `83c310af72`. The fork branch has other commits under it. The
  changed lines are the same in r186's `SSGINode.js`, so it should apply cleanly, possibly with an offset.
- Keep it as its own PR, separate from any #51 / #52 fixes.
- Suggested title: `SSGINode: Fix AO not reaching 1 on flat surfaces.`
- Suggested description:

> SSGINode's visibility bitmask marks `ceil( ( maxHorizon - minHorizon ) * 32 )` sectors from `floor( minHorizon * 32 )`.
> A sample on the shading point's own plane has a horizon interval of zero only up to depth/normal precision (and
> `GTAOFastAcos` vs `acos`), and `ceil` turns that into a full occluded sector. Flat, unoccluded surfaces therefore
> never reach an AO of 1 (typically ~0.9). This PR marks a sector when its center lies between the horizons (rounding
> both ends), which gives exactly 1 on flat surfaces and removes the half-sector average over-count on real occluders.
> Compared against ray-traced AO, RMSE drops 10–16 % in our test scenes. Since GI uses the same sector counts, indirect
> lighting becomes slightly darker where the over-count had been adding energy.
