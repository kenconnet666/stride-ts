/** 网格着色器里表面着色前要查的：像素所在的簇、贴花、DFG 表、淋不淋得到雨雪、地面的湿和积雪、云影、屏幕空间的间接光和接触阴影。 */
import { DFG_LUT_HEIGHT, DFG_LUT_WIDTH } from './view';

export const MESH_SURFACE_INPUTS = /* wgsl */ `
/** 像素所在的簇的簇头在 clusters 里的下标；视图没分簇时是 -1（看所有的光和贴花）。 */
fn clusterOf(position: vec4f, world: vec3f) -> i32 {
  if (view.cluster.w == 0.0) {
    return -1;
  }
  let depth = max(dot(world - view.eye.xyz, view.clusterView.xyz), 1e-4);
  let slice = u32(clamp((log(depth) - view.clusterView.w) * view.cluster.z, 0.0, f32(CLUSTER_Z - 1u)));
  let tile = min(vec2u(position.xy * view.cluster.xy), vec2u(CLUSTER_X - 1u, CLUSTER_Y - 1u));
  // cluster.w 是这个视图的槽 + 1；槽的簇头在缓冲的前面，一个槽 CLUSTER_HEADER_WORDS 个（第 0 个是计数器，然后每簇
  // CLUSTER_HEADER 个：起点、光数 | 贴花数 << 16、探针数）
  let slot = u32(view.cluster.w) - 1u;
  return i32(slot * CLUSTER_HEADER_WORDS + 1u + ((slice * CLUSTER_Y + tile.y) * CLUSTER_X + tile.x) * CLUSTER_HEADER);
}

/** 这一簇的光、贴花的个数（簇头的第二个数：光数 | 贴花数 << 16）。 */
fn clusterCounts(cluster: i32) -> vec2u {
  let packed = clusters[u32(cluster) + 1u];
  return vec2u(packed & 0xffffu, packed >> 16u);
}

/** 贴花、天气改过的表面和法线。 */
struct Decaled { surface: LayerSurface, normal: vec3f };

fn decodeSrgb(c: vec3f) -> vec3f {
  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

/**
 * 贴花（Godot 的做法）：world 落在哪个贴花的盒子里，就按盒子里的 xz 查贴图，颜色按 alpha 混进去，法线按贴花的切线空间
 * （x 轴是 u，-z 轴是贴图的上方，y 轴是法线）换算到世界再混进去；按表面和投影方向的夹角、在盒子里的高度淡出。后面的贴花
 * 盖在前面的上面。导数在循环外算（循环里是非一致的控制流）。
 */
fn applyDecals(world: vec3f, n: vec3f, s: LayerSurface, cluster: i32) -> Decaled {
  var r = Decaled(s, n);
  if (u32(view.decal.x) == 0u) {
    return r;
  }
  // 分了簇时只看这一簇的贴花（下标从小到大，先后不变；在这一簇的光的后面）
  let clustered = cluster >= 0;
  var count = u32(view.decal.x);
  var first = 0u;
  if (clustered) {
    let counts = clusterCounts(cluster);
    count = counts.y;
    first = clusters[u32(cluster)] + counts.x;
  }
  let dx = dpdx(world);
  let dy = dpdy(world);
  for (var k = 0u; k < count; k++) {
    let i = select(k, clusters[first + k], clustered);
    let d = decals[i];
    let p = (d.toBox * vec4f(world, 1.0)).xyz;
    if (any(abs(p) > vec3f(1.0))) {
      continue;
    }
    // 淡出：背着投影方向的面、盒子的顶部和底部
    var fade = d.color.w;
    if (d.fade.y > 0.0) {
      fade *= smoothstep(d.fade.y, min(d.fade.y + 0.3, 1.0), dot(n, d.axisY.xyz));
    }
    if (d.fade.z > 0.0) {
      fade *= saturate((1.0 - p.y) * 0.5 / d.fade.z);
    }
    if (d.fade.w > 0.0) {
      fade *= saturate((p.y + 1.0) * 0.5 / d.fade.w);
    }
    if (fade <= 0.0) {
      continue;
    }
    let uv = p.xz * 0.5 + 0.5;
    let duvx = (d.toBox * vec4f(dx, 0.0)).xz * 0.5;
    let duvy = (d.toBox * vec4f(dy, 0.0)).xz * 0.5;
    var alpha = fade;
    var albedo = d.color.rgb;
    if (d.albedo.z > 0.0) {
      let texel = textureSampleGrad(decalAtlas, linearClamp, d.albedo.xy + uv * d.albedo.zw, i32(d.pad.x), duvx * d.albedo.zw, duvy * d.albedo.zw);
      albedo *= decodeSrgb(texel.rgb);
      alpha *= texel.a;
    }
    r.surface.albedo = mix(r.surface.albedo, albedo, alpha * d.fade.x);
    if (d.normal.z > 0.0) {
      let t = textureSampleGrad(decalAtlas, linearClamp, d.normal.xy + uv * d.normal.zw, i32(d.pad.y), duvx * d.normal.zw, duvy * d.normal.zw).xyz * 2.0 - 1.0;
      let decalNormal = normalize(d.axisX.xyz * t.x - d.axisZ.xyz * t.y + d.axisY.xyz * max(t.z, 0.0));
      // 贴花的法线是相对一个平面的：按表面的法线转过去（平面上的凸起跟着表面走）
      r.normal = normalize(mix(r.normal, normalize(r.normal + decalNormal - d.axisY.xyz), alpha));
    }
  }
  return r;
}

/** DFG 查找表在 uv 处的值（x、y：GGX 的 scale、bias，z：光泽的）：双线性插值，边缘按 clamp（同原来的线性采样器）。 */
fn dfgLookup(uv: vec2f) -> vec4f {
  let size = vec2f(${DFG_LUT_WIDTH}.0, ${DFG_LUT_HEIGHT}.0);
  let t = clamp(uv * size - 0.5, vec2f(0.0), size - 1.0);
  let i0 = vec2u(floor(t));
  let i1 = min(i0 + 1u, vec2u(size) - 1u);
  let f = t - floor(t);
  let w = ${DFG_LUT_WIDTH}u;
  let a = mix(dfgLut[i0.y * w + i0.x], dfgLut[i0.y * w + i1.x], f.x);
  let b = mix(dfgLut[i1.y * w + i0.x], dfgLut[i1.y * w + i1.x], f.x);
  return mix(a, b, f.y);
}

/** world 淋不淋得到雨雪：1 是淋得到，0 是头顶有东西挡着（比深度图记的最高表面低 20 厘米以上）；图外、没有图时当淋得到。 */
fn skyExposure(world: vec3f) -> f32 {
  if (skyOcclusion.valid.x == 0u) {
    return 1.0;
  }
  let c = skyOcclusion.viewProjection * vec4f(world, 1.0);
  let uv = vec2f(c.x * 0.5 + 0.5, 0.5 - c.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) {
    return 1.0;
  }
  let size = skyOcclusion.valid.y;
  let texel = min(vec2u(uv * f32(size)), vec2u(size - 1u));
  let surface = skyOcclusionDepth[texel.y * size + texel.x];
  // 深度是线性的，覆盖 450 米（SkyOcclusion 的 ABOVE + BELOW）
  return select(1.0, 0.0, surface < 1.0 && c.z > surface + 0.2 / 450.0);
}

/** 二维值噪声，0..1：格点上的哈希按 smoothstep 插值。 */
fn valueNoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(cellHash(i), cellHash(i + vec2i(1, 0)), u.x);
  let b = mix(cellHash(i + vec2i(0, 1)), cellHash(i + vec2i(1, 1)), u.x);
  return mix(a, b, u.y);
}


/**
 * 天气改表面（Lagarde 2013 "Water drop 2 - Wet surfaces"、"Water drop 3 - Physically based wet surfaces" 的做法简化）：
 * - 湿：淋得到的非金属吸了水变暗（金属不吸水），表面一层水膜变光滑（朝上的更光滑）；
 * - 水洼：积了水以后，平的、淋得到的地方按世界 xz 的低频噪声积出一片片水（积得越多越大）：上面是一层平的水面——很光滑、
 *   按水的非金属算、底下的颜色更暗，法线朝上；下雨时有涟漪（rippleGradient）；
 * - 雪：淋得到、朝上的面积起来，积得越多越往斜面上长；积得不满时按世界 xz 的噪声一块一块的（满了就盖满）；雪是白的、
 *   粗糙的非金属，盖在水洼上面，把法线贴图的细节盖平（法线往几何法线 geometric 靠）。蒙皮的网格（skinned：角色、动物）一直
 *   在动，身上不积雪（湿照样湿）。
 * 竖着的面按往外 30 厘米的那一点判断淋不淋得到：墙面自己正上方是墙头，按自己的位置查总是被挡着。
 */
/**
 * 这个物体自己的状态层（MaterialParams 的 wet、dirt、wear、snow，0 到 1）。
 */
fn instanceState(slot: u32) -> vec4f {
  return unpack4x8unorm(instanceParams[slot].z);
}

/** 表面上的噪声（0 到 1）：按法线最朝的那个轴投影，墙、地、顶都有斑块；世界坐标加回渲染原点，相机走动时不滑。 */
fn surfaceNoise(world: vec3f, n: vec3f, scale: f32) -> f32 {
  let p = (world + view.origin.xyz) * scale;
  let a = abs(n);
  let plane = select(select(p.xy, p.zy, a.x > a.z), p.xz, a.y > max(a.x, a.z));
  return valueNoise(plane) * 0.65 + valueNoise(plane * 3.1 + 7.3) * 0.35;
}

/**
 * 脏和旧（这个物体的状态层，对所有材质通用）：脏积在缝里（GTAO 顺带算的曲率是凹的）、被遮住的地方、朝下的面，偏褐、变暗、变粗糙；
 * 旧在凸出的棱边，掉色发白（漆磨掉露出底）、变粗糙。按表面的噪声成斑，不是一层均匀的灰。
 */
fn ageSurface(world: vec3f, n: vec3f, position: vec4f, state: vec4f, s: LayerSurface) -> LayerSurface {
  let dirt = state.y;
  let wear = state.z;
  if (dirt <= 0.0 && wear <= 0.0) { return s; }
  var r = s;
  let curvature = screenCurvature(position);
  let occlusion = screenAmbient(position).w;
  if (dirt > 0.0) {
    let patches = surfaceNoise(world, n, 1.7);
    let cavity = saturate(-curvature * 4.0) + (1.0 - occlusion) * 0.8 + saturate(-n.y) * 0.4;
    // 斑块对比要大：脏是一块一块、一道一道的，不是整个变暗
    let mask = saturate(dirt * (0.45 + cavity) * smoothstep(0.25, 0.75, patches) * 1.6);
    r.albedo = mix(r.albedo, r.albedo * vec3f(0.42, 0.36, 0.28) + vec3f(0.035, 0.03, 0.022), mask * 0.85);
    r.metalness = mix(r.metalness, 0.0, mask * 0.7);
    r.roughness = mix(r.roughness, 0.92, mask * 0.75);
  }
  if (wear > 0.0) {
    let chips = surfaceNoise(world, n, 6.0);
    let edge = saturate(curvature * 6.0);
    // 棱边先旧，再是散开的掉漆斑；wear 越大斑越大（圆滑的东西到处都"凸"，不能光按曲率）
    let mask = smoothstep(0.55, 0.7, edge * 0.6 + chips * 0.5 + wear * 0.35) * step(0.001, wear);
    let gray = dot(r.albedo, vec3f(0.2126, 0.7152, 0.0722));
    r.albedo = mix(r.albedo, vec3f(gray * 0.6 + 0.25), mask * 0.7);
    r.roughness = mix(r.roughness, min(1.0, r.roughness + 0.35), mask);
  }
  return r;
}

fn weatherSurface(world: vec3f, n: vec3f, geometric: vec3f, skinned: bool, state: vec4f, s: LayerSurface) -> Decaled {
  let wetness = view.weather.x;
  let snowCover = view.weather.y;
  let puddles = view.weather.z;
  var result = Decaled(s, n);
  // 物体自己的湿、雪（状态层）：不看淋不淋得到
  let ownWet = state.x;
  let ownSnow = state.w;
  if (wetness <= 0.0 && snowCover <= 0.0 && puddles <= 0.0 && ownWet <= 0.0 && ownSnow <= 0.0) {
    return result;
  }
  let exposure = skyExposure(world + vec3f(n.x, 0.0, n.z) * 0.3);
  let up = saturate(n.y);
  var r = s;
  // 水洼之间的地面按 wetness 湿：雨停了它先干（5 分钟），水洼还在（15 分钟）
  let wet = max(wetness * exposure, ownWet);
  r.albedo *= mix(1.0, 0.45, wet * (1.0 - s.metalness));
  // 水膜让表面光滑一些，但保留材质自己粗糙度的变化（全压到一个很小的值，地面就成了一面映着天的镜子，贴图都看不见了）
  // 金属不吸水，水在上面成珠、不成一层均匀的膜：光滑得少（不然半金属的地面成了映着阴天的镜子）
  r.roughness = mix(s.roughness, max(s.roughness * 0.35, 0.1), wet * mix(0.6, 1.0, up) * (1.0 - 0.75 * s.metalness));
  if (puddles > 0.0 && exposure > 0.0) {
    // 两层噪声（几米和一米左右的斑块）；积水越多阈值越低、水洼越大，边缘 0.06 宽的过渡
    let ground = world.xz + view.origin.xz;
    let noise = valueNoise(ground * 0.35) * 0.7 + valueNoise(ground * 1.1 + 13.7) * 0.3;
    let water = smoothstep(0.94 - puddles * 0.55, 1.0 - puddles * 0.55, noise) * smoothstep(0.9, 0.98, n.y);
    if (water > 0.0) {
      r.albedo *= mix(1.0, 0.6, water);
      r.metalness = mix(r.metalness, 0.0, water);
      r.specular = mix(r.specular, vec3f(0.02), water);
      r.roughness = mix(r.roughness, 0.03, water);
      let g = rippleGradient(ground, view.locals.y, view.weather.w) * water;
      result.normal = normalize(mix(n, normalize(vec3f(-g.x, 1.0, -g.y)), water));
    }
  }
  // 积雪 0 时一点不积（以前写成 up · 1.2 - (1 - 积雪)，没雪时朝上的面也算出 0.9 的雪，下雨的地面成了白的），1 时朝上 0.2 以上都积满；
  // 不满时加上两层噪声（一米多和几十厘米的斑块），积得越多噪声越弱
  var snow = 0.0;
  if ((snowCover > 0.0 || ownSnow > 0.0) && !skinned) {
    let ground = world.xz + view.origin.xz;
    let patches = valueNoise(ground * 0.6 + 41.3) * 0.6 + valueNoise(ground * 2.3 + 5.1) * 0.4 - 0.5;
    snow = max(
      exposure * smoothstep(0.0, 0.25, 1.2 * (up - 1.0 + snowCover) + patches * (1.0 - snowCover)) * step(0.0001, snowCover),
      smoothstep(0.0, 0.25, 1.2 * (up - 1.0 + ownSnow) + patches * (1.0 - ownSnow)) * step(0.0001, ownSnow));
  }
  r.albedo = mix(r.albedo, vec3f(0.9), snow);
  r.metalness = mix(r.metalness, 0.0, snow);
  r.specular = mix(r.specular, vec3f(0.02), snow);
  r.roughness = mix(r.roughness, 0.75, snow);
  // 雪盖住了表面的细节（法线贴图、水洼的涟漪）
  result.normal = normalize(mix(result.normal, normalize(mix(n, geometric, 0.8)), snow));
  result.surface = r;
  return result;
}

/** 云的影子：从 world 朝光（toLight）看过去被云挡掉多少。先沿光线退到地面（y = 0）上的那个点，影子图是按地面上的点存的。 */
fn cloudShadow(world: vec3f, toLight: vec3f) -> f32 {
  let ground = world.xz - toLight.xz * (world.y / max(toLight.y, 0.05));
  return textureSampleLevel(cloudShadowMap, linearRepeat, ground * view.cloudShadow.x + view.cloudShadow.yz, 0.0).r;
}

/** xyz：屏幕空间的间接光（没有时是 0），w：环境光遮蔽。 */
fn screenAmbient(position: vec4f) -> vec4f {
  let size = textureDimensions(screenOcclusion);
  let texel = textureLoad(screenOcclusion, min(vec2u(position.xy) / 2u, size - 1u), 0);
  return select(vec4f(0.0, 0.0, 0.0, texel.r), texel, view.locals.z != 0.0);
}

/**
 * 表面的曲率（GTAO 顺带算的，AmbientOcclusion.ts）：大于 0 是凸的（边角），小于 0 是凹的（缝），量的是在约 3 厘米上弯了多少。
 * 屏幕空间全局光照接管 screenOcclusion 时没有，是 0。
 */
fn screenCurvature(position: vec4f) -> f32 {
  if (view.locals.z != 0.0) { return 0.0; }
  let size = textureDimensions(screenOcclusion);
  return textureLoad(screenOcclusion, min(vec2u(position.xy) / 2u, size - 1u), 0).g * 2.0 - 1.0;
}

/** 局部光的光追可见比例（RayTracedLocalLights，screenShadow 的 g）；只在视图常量的 decal.z 开着时读。 */
fn screenLocalVisibility(position: vec4f) -> f32 {
  let size = textureDimensions(screenShadow);
  return textureLoad(screenShadow, min(vec2u(position.xy), size - 1u), 0).g;
}

/** 投阴影的方向光的接触阴影（ContactShadows，全分辨率；没开时是白图）。 */
fn screenContactShadow(position: vec4f) -> f32 {
  let size = textureDimensions(screenShadow);
  return textureLoad(screenShadow, min(vec2u(position.xy), size - 1u), 0).r;
}
`;
