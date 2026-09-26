// Process-local shader experiments. No installed three.js files are modified.
import { registerHooks } from 'node:module';
export function installShaderExperiment(mode) {
  // Native and legacy weighting now use the renderer/node parameter. Only alternate shader prototypes need hooks.
  if (!mode || mode === 'baseline' || mode === 'sample-jacobian' || mode === 'legacy') return;
  const supported = ['skip-tangent', 'snap-samples', 'solid-angle', 'solid-angle-azimuth'];
  if (!supported.includes(mode)) throw new Error(`Unknown shader experiment: ${mode}`);
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.endsWith('/tsl/display/SSGINode.js')) return result;
      let source = String(result.source);
      function replace(before, after) {
        if (!source.includes(before)) throw new Error(`Shader experiment ${mode} no longer matches source`);
        source = source.replace(before, after);
      }
      // These alternative experiments are defined relative to the original angular estimator.
      // Remove the native correction first so the per-sector variants never apply it twice.
      replace(
        '.mul( normalDotLightDirection ).mul( solidAngleWeight ).mul( emission )',
        '.mul( normalDotLightDirection ).mul( emission )',
      );
      if (mode === 'skip-tangent') {
        replace(
          'globalOccludedBitfield.assign( globalOccludedBitfield.bitOr( currentOccludedBitfield ) );',
          `currentOccludedBitfield = dot( viewNormal, pixelToSample ).greaterThan( 0.001 ).select( currentOccludedBitfield, uint( 0 ) );
          globalOccludedBitfield.assign( globalOccludedBitfield.bitOr( currentOccludedBitfield ) );`,
        );
      }
      if (mode === 'snap-samples') {
        replace(
          'const sampleUV = uvNode.add( uvOffset.mul( uvDirection ) ).toConst();',
          'const sampleUV = floor( uvNode.add( uvOffset.mul( uvDirection ) ).mul( depthSize ) ).add( 0.5 ).div( depthSize ).toConst();',
        );
      }
      // Reference prototype: integrate receiver cosine and solid angle at each newly owned bit center.
      // This intentionally costs more than the sample-direction approximation; AO is unchanged.
      if (mode === 'solid-angle' || mode === 'solid-angle-azimuth') {
        replace('viewDir, viewNormal, n ]', 'viewDir, viewNormal, n, projectedLength ]');
        const call = 'uvNode, viewDir, viewNormal, n )';
        replace(call, 'uvNode, viewDir, viewNormal, n, projectedNormal.length() )');
        replace(call, 'uvNode, viewDir, viewNormal, n, projectedNormal.length() )');
        replace(
          'color.rgb.addAssign( float( numOccludedZones ).div( float( MAX_RAY ) ).mul( lightColor ).mul( normalDotLightDirection ).mul( emission ) );',
          `
          const sectorWeight = float( 0 ).toVar();
          Loop( { start: uint( 0 ), end: MAX_RAY, type: 'uint', condition: '<' }, ( { i: bit } ) => {
            If( currentOccludedBitfield.bitAnd( uint( 1 ).shiftLeft( bit ) ).notEqual( uint( 0 ) ), () => {
              const relativeAngle = float( bit ).add( 0.5 ).div( float( MAX_RAY ) ).mul( PI ).sub( HALF_PI );
              const viewAngle = relativeAngle.add( n );
              sectorWeight.addAssign( projectedLength.mul( cos( relativeAngle ) ).mul( abs( sin( viewAngle ) ) ).mul( 2 ).div( float( MAX_RAY ) ) );
            } );
          } );
          color.rgb.addAssign( sectorWeight.mul( lightColor ).mul( emission ) );`,
        );
      }
      // Correct the change of azimuth from uniform screen rotation to rotation around viewDir.
      if (mode === 'solid-angle-azimuth') {
        replace(
          'viewDir, viewNormal, n, projectedLength ]',
          'viewDir, viewNormal, n, projectedLength, azimuthWeight ]',
        );
        const call = 'n, projectedNormal.length() )';
        const weightedCall =
          'n, projectedNormal.length(), abs( viewDir.z ).div( float( 1 ).sub( dot( sliceDir, viewDir ).pow( 2 ) ) ) )';
        replace(call, weightedCall);
        replace(call, weightedCall);
        replace(
          'sectorWeight.mul( lightColor ).mul( emission )',
          'sectorWeight.mul( azimuthWeight ).mul( lightColor ).mul( emission )',
        );
      }
      return { ...result, source };
    },
  });
}
