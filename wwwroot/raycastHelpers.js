//// raycastHelpers.js
///**
// * Casts a ray downward from (x, largeY, z) until it intersects
// * any mesh in the scene (or an array of meshes).
// *
// * @param {THREE.Scene | THREE.Object3D[]} source - either a scene containing terrain meshes
// *                                                 or an array of terrain meshes
// * @param {number} x - horizontal X coordinate
// * @param {number} z - horizontal Z coordinate
// * @param {number} [maxHeight=200] - how high above the terrain to start
// * @return {number} The intersection Y, or 0 if no intersection found
// */
//export function getGroundHeightRaycast(source, x, z, maxHeight = 200) {
//    // 1) Create the raycaster from above
//    const rayOrigin = new THREE.Vector3(x, maxHeight, z);
//    const rayDir = new THREE.Vector3(0, -1, 0); // straight down
//    const raycaster = new THREE.Raycaster(rayOrigin, rayDir);

//    // 2) Determine which meshes to test
//    let meshes;
//    if (Array.isArray(source)) {
//        // if user passed an array of terrain or chunk meshes
//        meshes = source;
//    } else if (source.isScene) {
//        // if user passed a THREE.Scene, get children
//        meshes = source.children;
//    } else {
//        // fallback: assume it's a single Object3D or something
//        meshes = [source];
//    }

//    // 3) Intersect
//    const intersects = raycaster.intersectObjects(meshes, true);

//    // 4) If no hits, return 0
//    if (intersects.length === 0) {
//        return 0;
//    }

//    // The first intersection is the closest
//    return intersects[0].point.y;
//}
