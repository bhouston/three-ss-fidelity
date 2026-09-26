#!/usr/bin/env node

// Continuous reference for the angular integration used by SSGINode. This omits
// discrete depth fetches, bit quantization, temporal filtering, and denoising.
// Run with: node scripts/gi-angular-oracle.mjs

const PI = Math.PI;
const radii = [100, 120, 140, 160, 180, 200, 240];
const tilts = [0, 15, 30, 45, 60, 75, 90];
const emitterHalfWidth = 5;
const emitterHeight = 6;
const emitterDistance = 5;
const emitterRadiance = 0.5;
const receiverAlbedo = 0.5;

// Exact irradiance at the floor origin from the finite vertical rectangle.
const analyticCornerIrradiance =
  emitterRadiance *
  (Math.atan(emitterHalfWidth / emitterDistance) -
    (emitterDistance / Math.hypot(emitterDistance, emitterHeight)) *
      Math.atan(emitterHalfWidth / Math.hypot(emitterDistance, emitterHeight)));

function corner(nx, ny) {
  const totals = radii.map(() => ({ physical: 0, angular: 0 }));
  let fullPhysical = 0;
  let fullAngular = 0;
  const cameraY = 6;
  const cameraZ = 10;
  const targetY = 2;
  const forwardLength = Math.hypot(targetY - cameraY, -cameraZ);
  const forwardY = (targetY - cameraY) / forwardLength;
  const forwardZ = -cameraZ / forwardLength;
  const upY = -forwardZ;
  const upZ = forwardY;
  const focalPixels = 180 / Math.tan((55 * PI) / 360);
  const receiverDepth = -cameraY * forwardY - cameraZ * forwardZ;
  const receiverUp = -cameraY * upY - cameraZ * upZ;
  const receiverPixelY = 180 - (focalPixels * receiverUp) / receiverDepth;
  const viewLength = Math.hypot(cameraY, cameraZ);
  const viewY = cameraY / viewLength;
  const viewZ = cameraZ / viewLength;
  const dx = 10 / nx;
  const dy = 6 / ny;

  for (let iy = 0; iy < ny; iy++) {
    const y = (iy + 0.5) * dy;
    const cameraDy = y - cameraY;
    const cameraDz = -5 - cameraZ;
    const depth = cameraDy * forwardY + cameraDz * forwardZ;
    const up = cameraDy * upY + cameraDz * upZ;
    const pixelY = 180 - (focalPixels * up) / depth;

    for (let ix = 0; ix < nx; ix++) {
      const x = -5 + (ix + 0.5) * dx;
      const r2 = x * x + y * y + 25;
      // dE = L * cos(receiver) * cos(emitter) / r² dA.
      // Here L=0.5, cos(receiver)=y/r, cos(emitter)=5/r.
      const physical = (emitterRadiance * y * emitterDistance * dx * dy) / (r2 * r2);
      const cosView = (y * viewY - 5 * viewZ) / Math.sqrt(r2);
      const sinView = Math.sqrt(Math.max(0, 1 - cosView * cosView));
      // Existing gain pi²/2 converts d(alpha)d(phi) to half of that measure;
      // physical solid angle is |sin(alpha)| d(alpha)d(phi).
      const angular = physical / (2 * sinView);
      const pixelX = 240 + (focalPixels * x) / depth;
      const distancePixels = Math.hypot(pixelX - 240, pixelY - receiverPixelY);
      fullPhysical += physical;
      fullAngular += angular;
      for (let i = 0; i < radii.length; i++) {
        if (distancePixels <= radii[i]) {
          totals[i].physical += physical;
          totals[i].angular += angular;
        }
      }
    }
  }

  return {
    grid: [nx, ny],
    receiverPixel: [240, receiverPixelY],
    numericPhysicalIrradiance: fullPhysical,
    numericPhysicalOutgoingRadiance: (receiverAlbedo * fullPhysical) / PI,
    fullWallAngularToPhysical: fullAngular / fullPhysical,
    radii: radii.map((radiusPixels, i) => ({
      radiusPixels,
      physicalFraction: totals[i].physical / fullPhysical,
      angularEstimatorFraction: totals[i].angular / fullPhysical,
    })),
  };
}

function hemisphere(alphaSteps, azimuthSteps) {
  const results = tilts.map((tiltDegrees) => ({ tiltDegrees, oldRatio: 0, correctedRatio: 0 }));
  const dAlpha = (2 * PI) / alphaSteps;
  const dAzimuth = PI / azimuthSteps;
  for (let ia = 0; ia < alphaSteps; ia++) {
    const alpha = -PI + (ia + 0.5) * dAlpha;
    const sinAlpha = Math.sin(alpha);
    const cosAlpha = Math.cos(alpha);
    for (let ip = 0; ip < azimuthSteps; ip++) {
      const azimuth = (ip + 0.5) * dAzimuth;
      const x = sinAlpha * Math.cos(azimuth);
      for (const result of results) {
        const tilt = (result.tiltDegrees * PI) / 180;
        const receiverCosine = Math.max(0, Math.sin(tilt) * x + Math.cos(tilt) * cosAlpha);
        // pi²/2 gain, divided by pi for the true constant-radiance irradiance.
        const oldTerm = (receiverCosine * dAlpha * dAzimuth) / (2 * PI);
        result.oldRatio += oldTerm;
        result.correctedRatio += oldTerm * 2 * Math.abs(sinAlpha);
      }
    }
  }
  return { grid: [alphaSteps, azimuthSteps], results };
}

const cornerCoarse = corner(400, 240);
const cornerFine = corner(800, 480);
const hemisphereCoarse = hemisphere(512, 256);
const hemisphereFine = hemisphere(1024, 512);
const convergence = {
  cornerMaxAbsoluteRatioDifference: Math.max(
    Math.abs(cornerCoarse.fullWallAngularToPhysical - cornerFine.fullWallAngularToPhysical),
    ...cornerFine.radii.flatMap((fine, i) => [
      Math.abs(fine.physicalFraction - cornerCoarse.radii[i].physicalFraction),
      Math.abs(fine.angularEstimatorFraction - cornerCoarse.radii[i].angularEstimatorFraction),
    ]),
  ),
  hemisphereMaxAbsoluteRatioDifference: Math.max(
    ...hemisphereFine.results.flatMap((fine, i) => [
      Math.abs(fine.oldRatio - hemisphereCoarse.results[i].oldRatio),
      Math.abs(fine.correctedRatio - hemisphereCoarse.results[i].correctedRatio),
    ]),
  ),
};

const checks = {
  analyticCornerAbsoluteError: Math.abs(cornerFine.numericPhysicalIrradiance - analyticCornerIrradiance),
  cornerMaxAbsoluteRatioDifference: convergence.cornerMaxAbsoluteRatioDifference,
  hemisphereMaxAbsoluteRatioDifference: convergence.hemisphereMaxAbsoluteRatioDifference,
  correctedHemisphereMaxError: Math.max(...hemisphereFine.results.map((row) => Math.abs(row.correctedRatio - 1))),
};

if (
  checks.analyticCornerAbsoluteError > 1e-5 ||
  checks.cornerMaxAbsoluteRatioDifference > 2e-4 ||
  checks.hemisphereMaxAbsoluteRatioDifference > 5e-5 ||
  checks.correctedHemisphereMaxError > 1e-4
) {
  throw new Error(`Angular oracle failed numeric checks: ${JSON.stringify(checks)}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      description: 'Continuous angular-integration oracle for gi-emitter-corner and a uniform-bright hemisphere',
      assumptions: [
        'Corner geometry, camera, radiance, and receiver albedo match packages/scenes/src/gi-diagnostics.ts.',
        'The corner wall is fully visible and the receiver is the floor origin.',
        'The angular estimate uses the current pi²/2 gain and omits finite depth samples, bit quantization, and denoising.',
        'Projected screen-radius circles are an idealized footprint; expFactor and sample jitter make the actual shader footprint variable.',
        'The hemisphere oracle assumes continuous complete angular coverage, uniform slice azimuth about the view direction, and unit incident radiance.',
      ],
      analyticCornerIrradiance,
      corner: cornerFine,
      hemisphere: hemisphereFine,
      convergence,
      checks,
    },
    null,
    2,
  )}\n`,
);
