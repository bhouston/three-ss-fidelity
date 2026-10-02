// Three.js r187dev - Node System

// global
diagnostic( off, derivative_uniformity );


// directives


// structs

struct IntersectionResult {
	indices : vec4u,
	normal : vec3f,
	didHit : bool,
	barycoord : vec3f,
	objectIndex : u32,
	side : f32,
	dist : f32
};

struct Ray {
	origin : vec3f,
	direction : vec3f,
	maxDist : f32
};

struct BVHBoundingBox {
	min : array<f32, 3>,
	max : array<f32, 3>
};

struct BVHNode {
	bounds : BVHBoundingBox,
	rightChildOrTriangleOffset : u32,
	splitAxisOrTriangleCount : u32
};

struct bvh_GeometryStruct {
	position : vec4f,
	uv1 : vec2f
};

struct TransformStruct {
	matrixWorld : mat4x4f,
	inverseMatrixWorld : mat4x4f,
	visible : u32,
	_alignment0 : u32,
	_alignment1 : u32,
	_alignment2 : u32
};

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 0 ) @group( 0 ) var nodeUniform0 : texture_2d<f32>;
@binding( 2 ) @group( 0 ) var nodeUniform2 : texture_2d<f32>;
@binding( 3 ) @group( 0 ) var nodeUniform4_sampler : sampler;
@binding( 4 ) @group( 0 ) var nodeUniform4 : texture_2d<f32>;
@binding( 9 ) @group( 0 ) var nodeUniform11_sampler : sampler;
@binding( 10 ) @group( 0 ) var nodeUniform11 : texture_2d<f32>;
@binding( 11 ) @group( 0 ) var nodeUniform13_sampler : sampler;
@binding( 12 ) @group( 0 ) var nodeUniform13 : texture_2d<f32>;
@binding( 13 ) @group( 0 ) var nodeUniform15_sampler : sampler;
@binding( 14 ) @group( 0 ) var nodeUniform15 : texture_2d<f32>;
@binding( 15 ) @group( 0 ) var nodeUniform17_sampler : sampler;
@binding( 16 ) @group( 0 ) var nodeUniform17 : texture_2d<f32>;

struct bvh_transformsStruct {
	value : array< TransformStruct >
};
@binding( 5 ) @group( 0 )
var<storage, read> bvh_transforms : bvh_transformsStruct;

struct bvh_nodesStruct {
	value : array< BVHNode >
};
@binding( 6 ) @group( 0 )
var<storage, read> bvh_nodes : bvh_nodesStruct;

struct bvh_indexStruct {
	value : array< u32 >
};
@binding( 7 ) @group( 0 )
var<storage, read> bvh_index : bvh_indexStruct;

struct bvh_attributesStruct {
	value : array< bvh_GeometryStruct >
};
@binding( 8 ) @group( 0 )
var<storage, read> bvh_attributes : bvh_attributesStruct;

struct objectStruct {
	nodeUniform1 : mat3x3<f32>,
	nodeUniform3 : mat3x3<f32>,
	nodeUniform5 : mat3x3<f32>,
	nodeUniform6 : f32,
	nodeUniform12 : mat3x3<f32>,
	nodeUniform14 : mat3x3<f32>,
	nodeUniform16 : mat3x3<f32>,
	nodeUniform18 : mat3x3<f32>
};
@binding( 1 ) @group( 0 )
var<uniform> object : objectStruct;

// vars
var<private> nodeVar0 : vec2<i32>;
var<private> nodeVar1 : vec4<f32>;
var<private> nodeVar2 : vec4<f32>;
var<private> nodeVar3 : vec4<f32>;
var<private> nodeVar4 : vec3<f32>;
var<private> nodeVar5 : vec4<f32>;
var<private> nodeVar6 : vec4<f32>;
var<private> nodeVar7 : vec3<f32>;
var<private> nodeVar8 : vec3<f32>;
var<private> nodeVar9 : vec3<f32>;
var<private> nodeVar10 : vec3<f32>;
var<private> nodeVar11 : f32;
var<private> nodeVar12 : vec2<f32>;
var<private> nodeVar13 : f32;
var<private> nodeVar14 : f32;
var<private> nodeVar15 : vec3<f32>;
var<private> bvh_rayScalar_nulqj : f32;
var<private> nodeVar16 : IntersectionResult;
var<private> nodeVar17 : vec4<u32>;
var<private> nodeVar18 : vec3<f32>;
var<private> nodeVar19 : vec2<f32>;
var<private> nodeVar20 : vec4<f32>;
var<private> nodeVar21 : vec4<f32>;
var<private> nodeVar22 : vec4<f32>;
var<private> nodeVar23 : vec4<f32>;

// codes
fn lightBakeTrace(origin: vec3f, direction: vec3f, maxDist: f32) -> IntersectionResult {
        var hit: IntersectionResult;
        bvh_RaycastFirstHit(Ray(origin, direction, maxDist), &hit);
        return hit;
      }
fn bvh_RaycastFirstHit( shape: Ray, result: ptr<function, IntersectionResult> ) -> bool {

			

			var didHit = false;

			var isTLAS = true;
			var pointer: i32 = 0;
			var stack: array<u32, 60u>;
			stack[ 0 ] = 0u;

			var blasDidHit: bool = false;
			var objectIndex: u32 = 0;
			var localShape: Ray = shape;

						var tlasReset: i32 = 0;

			loop {

												if ( ! isTLAS && tlasReset == pointer ) {

					if ( blasDidHit ) {

						blasDidHit = false;
						didHit = true;
						transformResult( result, objectIndex );

					}

					resetRayScalar( objectIndex );

					objectIndex = 0;
					isTLAS = true;
					localShape = shape;

				}

								if ( pointer < 0 || pointer >= i32( 60u ) ) {

					break;

				}

				let nodeIndex = stack[ pointer ];
				let node = bvh_nodes.value[ nodeIndex ];
				pointer = pointer - 1;

								if ( rayIntersectsBounds( localShape, node.bounds, result ) == 0u ) {

					continue;

				}

				let infoX = node.splitAxisOrTriangleCount;
				let infoY = node.rightChildOrTriangleOffset;
				let isLeaf = ( infoX & 0xffff0000u ) != 0u;

				if ( isLeaf ) {

					if ( isTLAS ) {

																								objectIndex = infoX & 0x00ffffffu;

						let transform = bvh_transforms.value[ objectIndex ];
						if ( transform.visible != 0u ) {

							tlasReset = pointer;
							isTLAS = false;
							blasDidHit = false;

														localShape = shape;
							transformRay( &localShape, objectIndex );

							pointer = pointer + 1;
							stack[ pointer ] = infoY;

						}

					} else {

						let count = infoX & 0x0000ffffu;
						let offset = infoY;
						blasDidHit = intersectRange( localShape, offset, count, result ) || blasDidHit;

					}

				} else {

					let leftIndex = nodeIndex + 1u;
					let splitAxis = infoX & 0x0000ffffu;
					let rightIndex = nodeIndex + infoY;

					var c1 = rightIndex;
					var c2 = leftIndex;
					
			let leftToRight = getBoundsOrder( localShape, splitAxis, node );
			c1 = select( rightIndex, leftIndex, leftToRight );
			c2 = select( leftIndex, rightIndex, leftToRight );
		

					pointer = pointer + 1;
					stack[ pointer ] = c2;

					pointer = pointer + 1;
					stack[ pointer ] = c1;

				}

			}

			return didHit;

		}
fn transformResult( hit: ptr<function, IntersectionResult>, objectIndex: u32 )  {

				let toLocal = bvh_transforms.value[ objectIndex ].inverseMatrixWorld;
				hit.normal = normalize( ( transpose( toLocal ) * vec4f( hit.normal, 0.0 ) ).xyz );
				hit.objectIndex = objectIndex;

			}
fn resetRayScalar( objectIndex: u32 )  {

				bvh_rayScalar_nulqj = 1.0;

			}
fn rayIntersectsBounds( ray: Ray, bounds: BVHBoundingBox, result: ptr<function, IntersectionResult> ) -> u32 {

				let boundsMin = vec3( bounds.min[0], bounds.min[1], bounds.min[2] );
				let boundsMax = vec3( bounds.max[0], bounds.max[1], bounds.max[2] );

				let invDir = 1.0 / ray.direction;
				let tMinPlane = ( boundsMin - ray.origin ) * invDir;
				let tMaxPlane = ( boundsMax - ray.origin ) * invDir;

				let tMinHit = vec3f(
					min( tMinPlane.x, tMaxPlane.x ),
					min( tMinPlane.y, tMaxPlane.y ),
					min( tMinPlane.z, tMaxPlane.z )
				);

				let tMaxHit = vec3f(
					max( tMinPlane.x, tMaxPlane.x ),
					max( tMinPlane.y, tMaxPlane.y ),
					max( tMinPlane.z, tMaxPlane.z )
				);

				let t0 = max( max( tMinHit.x, tMinHit.y ), tMinHit.z );
				let t1 = min( min( tMaxHit.x, tMaxHit.y ), tMaxHit.z );

				let dist = max( t0, 0.0 );
				if ( t1 < dist ) {

					return 0u;

				} else if ( ray.maxDist > 0.0 && dist * bvh_rayScalar_nulqj >= ray.maxDist ) {

					return 0u;

				} else if ( result.didHit && dist * bvh_rayScalar_nulqj >= result.dist ) {

					return 0u;

				} else {

					return 1u;

				}

			}
fn transformRay( ray: ptr<function, Ray>, objectIndex: u32 )  {

				let toLocal = bvh_transforms.value[ objectIndex ].inverseMatrixWorld;
				ray.origin = ( toLocal * vec4f( ray.origin, 1.0 ) ).xyz;
				ray.direction = ( toLocal * vec4f( ray.direction, 0.0 ) ).xyz;

				let len = length( ray.direction );
				ray.direction /= len;
				bvh_rayScalar_nulqj = 1.0 / len;

			}
fn intersectRange( ray: Ray, offset: u32, count: u32, result: ptr<function, IntersectionResult> ) -> bool {

				var didHit = false;
				for ( var ti = offset; ti < offset + count; ti = ti + 1u ) {

					let i0 = bvh_index.value[ ti * 3u ];
					let i1 = bvh_index.value[ ti * 3u + 1u ];
					let i2 = bvh_index.value[ ti * 3u + 2u ];

					let a = bvh_attributes.value[ i0 ].position.xyz;
					let b = bvh_attributes.value[ i1 ].position.xyz;
					let c = bvh_attributes.value[ i2 ].position.xyz;

					var triResult = intersectRayTriangle( ray, a, b, c, 0.0 );
					triResult.dist *= bvh_rayScalar_nulqj;
					if ( triResult.didHit && ( ray.maxDist <= 0.0 || triResult.dist < ray.maxDist ) && ( ! result.didHit || triResult.dist < result.dist ) ) {

						result.didHit = true;
						result.dist = triResult.dist;
						result.normal = triResult.normal;
						result.side = triResult.side;
						result.barycoord = triResult.barycoord;
						result.indices = vec4u( i0, i1, i2, ti );

						didHit = true;

					}

				}

				return didHit;

			}
fn intersectRayTriangle( ray: Ray, a: vec3f, b: vec3f, c: vec3f, threshold: f32 ) -> IntersectionResult {

		const DET_EPSILON = 1e-15;

		var result: IntersectionResult;
		result.didHit = false;

		let edge1 = b - a;
		let edge2 = c - a;
		let n = cross( edge1, edge2 );

		let det = - dot( ray.direction, n );
		if ( abs( det ) < DET_EPSILON ) {

			return result;

		}

		let invdet = 1.0 / det;

		let AO = ray.origin - a;
		let DAO = cross( AO, ray.direction );

		let u = dot( edge2, DAO ) * invdet;
		if ( u < 0.0 || u > 1.0 ) {

			return result;

		}

		let v = - dot( edge1, DAO ) * invdet;
		if ( v < 0.0 || u + v > 1.0 ) {

			return result;

		}

		let t = dot( AO, n ) * invdet;
		let w = 1.0 - u - v;
		if ( t < threshold ) {

			return result;

		}

		result.didHit = true;
		result.barycoord = vec3f( w, u, v );
		result.dist = t;
		result.side = sign( det );
		result.normal = result.side * normalize( n );

		return result;

	}
fn getBoundsOrder( ray: Ray, splitAxis: u32, node: BVHNode ) -> bool {

				return ray.direction[ splitAxis ] >= 0.0;

			}


@fragment
fn main( @builtin( position ) fragCoord : vec4<f32> ) -> OutputStruct {

	// flow
	// code

	nodeVar0 = vec2<i32>( fragCoord.xy );
	nodeVar1 = textureLoad( nodeUniform0, vec2<i32>( ( object.nodeUniform1 * vec3<f32>( vec2<f32>( nodeVar0 ), 1.0 ) ).xy ), u32( 0u ) );
	nodeVar2 = nodeVar1;
	nodeVar3 = textureLoad( nodeUniform2, vec2<i32>( ( object.nodeUniform3 * vec3<f32>( vec2<f32>( nodeVar0 ), 1.0 ) ).xy ), u32( 0u ) );
	nodeVar4 = normalize( ( ( nodeVar3.xyz * vec3<f32>( 2.0 ) ) - vec3<f32>( 1.0 ) ) );
	nodeVar5 = textureLoad( nodeUniform4, vec2<i32>( ( object.nodeUniform5 * vec3<f32>( vec2<f32>( nodeVar0 ), 1.0 ) ).xy ), u32( 0u ) );
	nodeVar6 = nodeVar5;
	nodeVar7 = vec3<f32>( 0.0, 0.0, 0.0 );

	if ( ( nodeVar2.w > 0.0 ) ) {


		if ( ( abs( nodeVar4.z ) < 0.999 ) ) {

			nodeVar8 = vec3<f32>( 0.0, 0.0, 1.0 );

		} else {

			nodeVar8 = vec3<f32>( 1.0, 0.0, 0.0 );

		}

		nodeVar9 = normalize( cross( nodeVar8, nodeVar4 ) );
		nodeVar10 = cross( nodeVar4, nodeVar9 );

		for ( var bakeSample : i32 = 0; bakeSample < 16; bakeSample ++ ) {

			nodeVar11 = ( ( object.nodeUniform6 * 16.0 ) + f32( bakeSample ) );
			nodeVar12 = fract( ( vec2<f32>( ( nodeVar11 * 0.754877666 ), ( nodeVar11 * 0.569840296 ) ) + vec2<f32>( fract( ( sin( dot( floor( fragCoord.xy ), vec2<f32>( 12.9898, 78.233 ) ) ) * 43758.5453 ) ) ) ) );
			nodeVar13 = sqrt( nodeVar12.x );
			nodeVar14 = ( nodeVar12.y * 6.283185307179586 );
			nodeVar15 = ( ( ( nodeVar9 * vec3<f32>( ( nodeVar13 * cos( nodeVar14 ) ) ) ) + ( nodeVar10 * vec3<f32>( ( nodeVar13 * sin( nodeVar14 ) ) ) ) ) + ( nodeVar4 * vec3<f32>( sqrt( ( 1.0 - nodeVar12.x ) ) ) ) );
			bvh_rayScalar_nulqj = 1.0;
			nodeVar16 = lightBakeTrace( ( nodeVar2.xyz + ( nodeVar4 * vec3<f32>( 0.00032252912951662675 ) ) ), nodeVar15, 0.0 );

			if ( ( nodeVar16.didHit && ( nodeVar16.side > 0.0 ) ) ) {

				nodeVar17 = vec4<u32>( nodeVar16.indices );
				nodeVar18 = vec3<f32>( nodeVar16.barycoord );
				nodeVar19 = ( ( ( vec2<f32>( bvh_attributes.value[ nodeVar17.x ].uv1 ) * vec2<f32>( nodeVar18.x ) ) + ( vec2<f32>( bvh_attributes.value[ nodeVar17.y ].uv1 ) * vec2<f32>( nodeVar18.y ) ) ) + ( vec2<f32>( bvh_attributes.value[ nodeVar17.z ].uv1 ) * vec2<f32>( nodeVar18.z ) ) );
				nodeVar20 = textureSample( nodeUniform11, nodeUniform11_sampler, ( object.nodeUniform12 * vec3<f32>( nodeVar19, 1.0 ) ).xy );
				nodeVar21 = textureSample( nodeUniform13, nodeUniform13_sampler, ( object.nodeUniform14 * vec3<f32>( nodeVar19, 1.0 ) ).xy );
				nodeVar22 = textureSample( nodeUniform15, nodeUniform15_sampler, ( object.nodeUniform16 * vec3<f32>( nodeVar19, 1.0 ) ).xy );
				nodeVar23 = textureSample( nodeUniform17, nodeUniform17_sampler, ( object.nodeUniform18 * vec3<f32>( nodeVar19, 1.0 ) ).xy );
				nodeVar7 = ( nodeVar7 + ( ( nodeVar20.xyz * ( nodeVar21.xyz + nodeVar22.xyz ) ) + ( nodeVar23.xyz * vec3<f32>( 3.141592653589793 ) ) ) );
				

			}


		}

		

	}


	// result

	output.color = vec4<f32>( mix( nodeVar6.xyz, ( nodeVar7 / vec3<f32>( 16.0 ) ), max( ( 1.0 / ( object.nodeUniform6 + 1.0 ) ), 0.04 ) ), nodeVar2.w );

	return output;

}
