/** 网格着色器的顶点部分：形变、蒙皮、植被的风、地形块、远处卡片的顶点，各种顶点格式的入口，运动向量的顶点和片元。 */
import { HEIGHT_PAGE_HEADER, HEIGHT_PAGE_SAMPLES } from '../HeightPages';
import { IMPOSTOR_FRAMES } from '../Mesh';
import { VEGETATION_LOCAL_WINDS } from './view';

export const MESH_VERTEX = /* wgsl */ `
/** 顶点的形变增量（Stride 的 MorphTargets：按权重加各个目标的位置和法线增量），在网格空间里、蒙皮之前。 */
struct MorphDelta { position: vec3f, normal: vec3f };
/** 第 kind 种缓冲（0 世界矩阵，1 蒙皮表，2 蒙皮矩阵，3 形变表，4 形变权重）这一帧或上一帧的那一半从哪起。 */
fn frameBase(kind: u32, previous: bool) -> u32 {
  let k = kind * 2u + select(0u, 1u, previous);
  return view.bases[k / 4u][k % 4u];
}

fn morphDelta(slot: u32, vertex: u32, previous: bool) -> MorphDelta {
  var delta = MorphDelta(vec3f(0.0), vec3f(0.0));
  if (!MORPHED) { return delta; }
  let base = morphOf[frameBase(3u, previous) + slot] + frameBase(4u, previous);
  let first = morphData[0];
  for (var e = morphData[1u + vertex]; e < morphData[2u + vertex]; e++) {
    let at = first + e * 8u;
    let w = morphWeights[base + morphData[at + 3u]];
    delta.position += w * vec3f(bitcast<f32>(morphData[at]), bitcast<f32>(morphData[at + 1u]), bitcast<f32>(morphData[at + 2u]));
    delta.normal += w * vec3f(bitcast<f32>(morphData[at + 4u]), bitcast<f32>(morphData[at + 5u]), bitcast<f32>(morphData[at + 6u]));
  }
  return delta;
}

/** 八面体编码还原成单位向量（同 meshopt 的 octahedral 滤波，资源管线的编码见 packages/pipeline/src/mesh.ts）。 */
fn octDecode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

struct Varyings {
  // invariant：深度预通道和不透明阶段的管线算出完全相同的深度，less-equal 才不会漏掉像素
  @invariant @builtin(position) position: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  // 视图空间的深度（裁剪坐标的 w），选阴影级联用（Stride 的 DepthVS）
  @location(3) depth: f32,
  // 世界空间的切线和手性；网格没有切线时是 0
  @location(4) tangent: vec4f,
  // 模型空间的位置（材质的颜色树里的 streams.position，Stride 的 POSITION）
  @location(5) local: vec3f,
  // 网格效果在顶点着色器里算、给片元着色器用的值（effectVarying，比如雾因子）
  @location(6) effect: vec4f,
  // 实例的变换槽位（点选的编号缓冲写它）
  @location(7) @interpolate(flat) slot: u32,
  // 1 是蒙皮的网格（角色、动物：一直在动，身上不积雪）
  @location(8) @interpolate(flat) skinned: u32,
  // 细线（Material.wire）加粗了多少：片元着色器按它抖动着丢像素（0 是没加粗，越大越细）
  @location(9) wireFade: f32,
};

const IDENTITY = mat4x4f(1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0);

/**
 * skin 把网格空间的顶点变到模型空间（蒙皮矩阵的加权和；不蒙皮时是单位矩阵，编译器会把它消掉）；形变在蒙皮之前加上
 * （同 Stride：先形变后蒙皮）。
 */
/**
 * 植被的风（Material.wind，见那里的说明）：p 是渲染空间里的世界位置，world 是实体的世界矩阵，localNormal 是模型空间的法线。
 * 弯：顺风方向挪 bend · (风速 / 10) · (高度 / 10)²，风速按每棵树错开相位的慢摆（0.65..1）调，再按挪的距离往下降一点（保持
 * 树干的长度）；抖：离树干的竖直轴 2 米以外的顶点沿法线抖 flutter · (风速 / 10)，频率高、每个顶点相位不同。
 * 草的模式：高度是 (1 − uv.v) · 10（梢摆 bend），相位按顶点自己的位置（一个网格里的草叶各摆各的）。
 */
/** 渲染空间里 q 处的风速：全局风加上局部风源从中心往外的推力（同 WindField.sample，线性衰减，不算湍流）。 */
fn windAt(q: vec3f) -> vec3f {
  var v = view.wind.xyz;
  for (var i = 0u; i < ${VEGETATION_LOCAL_WINDS}u; i++) {
    let zone = view.windLocals[i];
    let strength = view.windStrengths[i];
    let d = q - zone.xyz;
    let distance = length(d);
    if (strength != 0.0 && distance < zone.w && distance > 1e-3) {
      v += d / distance * strength * (1.0 - distance / zone.w);
    }
  }
  return v;
}

fn windSway(p: vec3f, world: mat4x4f, localNormal: vec3f, uv: vec2f) -> vec3f {
  let bend = material.wind.x;
  let flutter = material.wind.y;
  if (bend <= 0.0 && flutter <= 0.0) {
    return p;
  }
  let origin = world[3].xyz;
  let grass = material.wind.z > 0.5;
  // 树按树根处的风整棵弯（局部风源里一棵树不会被撕开），草按每片自己的位置
  let wind = windAt(select(origin, p, grass));
  let horizontal = vec2f(wind.x, wind.z);
  let speed = length(horizontal);
  if (speed < 0.001) {
    return p;
  }
  let height = select(max(p.y - origin.y, 0.0), (1.0 - uv.y) * 10.0, grass);
  let time = view.locals.y;
  // 相位按世界坐标（加上渲染原点取模的部分：原点换了不跳）；顺着风的方向推进，阵风像波一样扫过林子
  let place = select(origin.xz, p.xz, grass) + view.origin.xz;
  let direction = horizontal / speed;
  let phase = dot(place, direction) * 0.08 + dot(place, vec2f(0.37, 0.61)) * 0.05;
  let strength = speed * 0.1;
  let sway = 0.65 + 0.35 * sin(time * 1.4 - phase);
  let amount = bend * strength * sway * (height * 0.1) * (height * 0.1);
  var offset = vec3f(direction.x, 0.0, direction.y) * amount;
  offset.y = -0.5 * amount * amount / max(height, 0.5);
  let reach = clamp((length(p.xz - origin.xz) - 2.0) * 0.5, 0.0, 1.0);
  if (flutter > 0.0 && reach > 0.0) {
    let normal = normalize((world * vec4f(localNormal, 0.0)).xyz + vec3f(0.0, 1e-6, 0.0));
    let wobble = sin(time * 7.3 + dot(p, vec3f(1.7, 1.3, 2.1))) * 0.6 + sin(time * 11.1 + dot(p, vec3f(-2.3, 0.9, 1.1))) * 0.4;
    offset += normal * (flutter * strength * reach * wobble);
  }
  return p + offset;
}

/** 细线最少画多宽（像素）。 */
const WIRE_MIN_PIXELS = 1.5;

/**
 * 细线（Material.wire，phone-wire AA）：p 是细管子表面上的点，n 是它的法线（从管子的中心线指出来），radius 是管子的半径。
 * 在中心线处量一个像素多宽（垂直于视线挪 1 厘米投到画面上），管子不到 WIRE_MIN_PIXELS 宽时加粗到这么宽；返回新的位置和
 * 加粗的程度（1 − 真实宽度 / 画的宽度，片元着色器按它抖动着丢像素，平均下来亮度同真实的粗细）。
 */
fn wireWiden(p: vec3f, n: vec3f, radius: f32) -> vec4f {
  let center = p - n * radius;
  let ray = normalize(center - view.eye.xyz);
  let side = normalize(cross(ray, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(ray.y) > 0.9)));
  let a = view.viewProjection * vec4f(center, 1.0);
  let b = view.viewProjection * vec4f(center + side * 0.01, 1.0);
  if (a.w <= 0.0 || b.w <= 0.0) {
    return vec4f(p, 0.0);
  }
  let pixelsPerMeter = length((b.xy / b.w - a.xy / a.w) * view.pixel.xy * 0.5) * 100.0;
  let width = 2.0 * radius * pixelsPerMeter;
  if (width >= WIRE_MIN_PIXELS || pixelsPerMeter <= 0.0) {
    return vec4f(p, 0.0);
  }
  return vec4f(center + n * (WIRE_MIN_PIXELS / (2.0 * pixelsPerMeter)), 1.0 - width / WIRE_MIN_PIXELS);
}

fn transformVertex(position: vec3f, normal: vec3f, uv: vec2f, tangent: vec4f, slot: u32, vertex: u32, skin: mat4x4f, skinned: bool) -> Varyings {
  let world = worlds[frameBase(0u, false) + slot];
  let morph = morphDelta(slot, vertex, false);
  let local = (skin * vec4f(mesh.positionOffset.xyz + position * mesh.positionScale.xyz + morph.position, 1.0)).xyz;
  let localNormal = (skin * vec4f(select(normal, octDecode(normal.xy), (mesh.flags & 1u) != 0u) + morph.normal, 0.0)).xyz;
  let localTangent = (skin * vec4f(tangent.xyz, 0.0)).xyz;
  let meshUv = mesh.uvTransform.zw + uv * mesh.uvTransform.xy;
  // 材质的位移贴图：顶点沿模型空间的法线移动（Stride 的 MaterialSurfaceDisplacement，MaterialShader 的水波）
  let displaced = local + normalize(localNormal) * treeDisplacement(meshUv, local);
  // 植被的风；网格效果可以在投影前改世界位置（Stride 的 PreTransformPosition，SpaceEscape 的走廊往远处弯）
  var worldPosition = vec4f(effectWorldPosition(windSway((world * vec4f(displaced, 1.0)).xyz, world, localNormal, meshUv), mesh.effect), 1.0);
  var out: Varyings;
  if (material.wind.w > 0.0) {
    let wire = wireWiden(worldPosition.xyz, normalize((world * vec4f(localNormal, 0.0)).xyz), material.wind.w * length(world[0].xyz));
    worldPosition = vec4f(wire.xyz, 1.0);
    out.wireFade = wire.w;
  }
  out.position = view.viewProjection * worldPosition;
  out.world = worldPosition.xyz;
  out.effect = effectVarying(out.position, worldPosition.xyz, mesh.effect);
  // 法线用世界矩阵的逆转置变换（Stride 的 WorldInverseTranspose）：缩放不等比时直接乘世界矩阵，斜着的法线会歪。
  // 逆转置乘上行列式就是余子式矩阵（三次叉乘），长度反正要在片元着色器里归一；行列式是负的（镜像）时方向要反回来
  let cofactor = mat3x3f(cross(world[1].xyz, world[2].xyz), cross(world[2].xyz, world[0].xyz), cross(world[0].xyz, world[1].xyz));
  out.normal = cofactor * localNormal * select(-1.0, 1.0, dot(world[0].xyz, cofactor[0]) >= 0.0);
  out.uv = effectUv(meshUv, mesh.effect);
  out.depth = out.position.w;
  out.tangent = vec4f((world * vec4f(localTangent, 0.0)).xyz, tangent.w);
  out.local = local;
  out.slot = slot;
  out.skinned = select(0u, 1u, skinned);
  return out;
}

/**
 * 上一帧这个顶点在世界里的位置（运动向量用）：同 transformVertex 的位置，只是世界矩阵、蒙皮、形变都取上一帧的。
 * 网格效果（随时间变的）按这一帧算。
 */
fn previousWorldPosition(position: vec3f, normal: vec3f, uv: vec2f, slot: u32, vertex: u32, skin: mat4x4f) -> vec4f {
  let world = worlds[frameBase(0u, true) + slot];
  let morph = morphDelta(slot, vertex, true);
  let local = (skin * vec4f(mesh.positionOffset.xyz + position * mesh.positionScale.xyz + morph.position, 1.0)).xyz;
  let localNormal = (skin * vec4f(select(normal, octDecode(normal.xy), (mesh.flags & 1u) != 0u) + morph.normal, 0.0)).xyz;
  let meshUv = mesh.uvTransform.zw + uv * mesh.uvTransform.xy;
  let displaced = local + normalize(localNormal) * treeDisplacement(meshUv, local);
  return vec4f(effectWorldPosition(windSway((world * vec4f(displaced, 1.0)).xyz, world, localNormal, meshUv), mesh.effect), 1.0);
}

/** 顶点的蒙皮矩阵：4 个关节的蒙皮矩阵按权重相加（Stride 的 TransformationSkinning）；previous 取上一帧的。 */
fn skinMatrix(slot: u32, joints: vec4u, weights: vec4f, previous: bool) -> mat4x4f {
  let base = paletteOf[frameBase(1u, previous) + slot] + frameBase(2u, previous);
  return palettes[base + joints.x] * weights.x + palettes[base + joints.y] * weights.y
    + palettes[base + joints.z] * weights.z + palettes[base + joints.w] * weights.w;
}

@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  return transformVertex(position, normal, uv, vec4f(0.0), slots[instance], vertex, IDENTITY, false);
}

/**
 * 表面颜色的烘焙（RenderStage.surfaceBake，raytracing/SurfaceColors.ts）：顶点按纹理坐标（按网格的范围归一）铺满视口（图集的一格），
 * 世界位置照常算（按世界坐标的材质节点照样对）。实例号直接是槽位（画的时候 firstInstance 给槽位，不经视图的实例表）。
 */
@vertex fn vsSurfaceBake(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) slot: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  var out = transformVertex(position, normal, uv, vec4f(0.0), slot, vertex, IDENTITY, false);
  let t = (out.uv - mesh.uvBounds.xy) * mesh.uvBounds.zw;
  out.position = vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.5, 1.0);
  return out;
}

@vertex fn vsTangent(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) tangent: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  return transformVertex(position, normal, uv, tangent, slots[instance], vertex, IDENTITY, false);
}

@vertex fn vsSkinned(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let slot = slots[instance];
  return transformVertex(position, normal, uv, vec4f(0.0), slot, vertex, skinMatrix(slot, joints, weights, false), true);
}

@vertex fn vsSkinnedTangent(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) tangent: vec4f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let slot = slots[instance];
  return transformVertex(position, normal, uv, tangent, slot, vertex, skinMatrix(slot, joints, weights, false), true);
}

/** 高度场网格的一个顶点（格坐标 i、j 和是不是裙边）按这个实体的高度页摆好：网格空间的位置、法线、UV、切线。 */
struct HeightfieldVertex { position: vec3f, normal: vec3f, uv: vec2f, tangent: vec4f };
fn heightfieldVertex(grid: vec3f, slot: u32) -> HeightfieldVertex {
  let base = morphOf[frameBase(3u, false) + slot];
  let i = u32(grid.x);
  let j = u32(grid.z);
  let at = base + ${HEIGHT_PAGE_HEADER}u + (j + 1u) * ${HEIGHT_PAGE_SAMPLES}u + i + 1u;
  // 每格的高度差（网格空间里 x、z 一格是 1，实体的缩放把它放大成米；法线经余子式矩阵变到世界里，斜率跟着对）
  let dx = (heights[at + 1u] - heights[at - 1u]) * 0.5;
  let dz = (heights[at + ${HEIGHT_PAGE_SAMPLES}u] - heights[at - ${HEIGHT_PAGE_SAMPLES}u]) * 0.5;
  var out: HeightfieldVertex;
  out.position = vec3f(grid.x, heights[at] - grid.y * heights[base + 3u], grid.z);
  out.normal = vec3f(-dx, 1.0, -dz);
  out.uv = vec2f(heights[base], heights[base + 1u]) + grid.xz * heights[base + 2u];
  // 切线沿 +x（u），bitangent 沿 +z（v 也沿 +z）
  out.tangent = vec4f(1.0, dx, 0.0, -1.0);
  return out;
}

@vertex fn vsHeightfield(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let slot = slots[instance];
  let v = heightfieldVertex(position, slot);
  return transformVertex(v.position, v.normal, v.uv, v.tangent, slot, vertex, IDENTITY, false);
}

/** 地形块的表面颜色的烘焙（同 vsSurfaceBake）：块的格坐标（0..${HEIGHT_PAGE_SAMPLES - 3}）铺满一格，实例号是槽位。 */
@vertex fn vsSurfaceBakeHeightfield(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) slot: u32, @builtin(vertex_index) vertex: u32) -> Varyings {
  let v = heightfieldVertex(position, slot);
  var out = transformVertex(v.position, v.normal, v.uv, v.tangent, slot, vertex, IDENTITY, false);
  let t = position.xz / ${HEIGHT_PAGE_SAMPLES - 3}.0;
  out.position = vec4f(t.x * 2.0 - 1.0, 1.0 - t.y * 2.0, 0.5, 1.0);
  return out;
}

/**
 * 远处卡片（MeshData.impostor，Impostors.ts）的一个角：center 是卡片中心（模型空间），corner 是这个角离中心的偏移（米）。
 * 卡片绕竖直轴转向相机（透视的视图）或整个转向光（正交的视图：阴影、天空遮挡，从高处的太阳看竖着的卡片只是一条线）；
 * 图集的格子按相机在实例自己的朝向里的方位角选最近的一格。切线是卡片的右、副切线是上，烘的法线图在这个框架里。植被的风照常
 * 弯（按树根处的风），卡片跟着整棵树摆。
 */
fn impostorVertex(center: vec3f, corner: vec2f, uv: vec2f, slot: u32) -> Varyings {
  let world = worlds[frameBase(0u, false) + slot];
  let middle = (world * vec4f(center, 1.0)).xyz;
  let scale = length(world[1].xyz);
  let vp = view.viewProjection;
  // 正交投影：裁剪坐标的 w 不随位置变；它的第三行是视图的前方（正向深度）
  let ortho = abs(vp[0][3]) + abs(vp[1][3]) + abs(vp[2][3]) < 1e-6;
  let toward = select(view.eye.xyz - middle, -vec3f(vp[0][2], vp[1][2], vp[2][2]), ortho);
  var level = toward.xz;
  if (dot(level, level) < 1e-10) {
    level = world[2].xz;
  }
  let d = normalize(level);
  let right = vec3f(d.y, 0.0, -d.x);
  let facing = select(vec3f(d.x, 0.0, d.y), normalize(toward), ortho);
  let up = cross(facing, right);
  // 第 k 格是从实例本地的 (sin θ, 0, cos θ) 方向看的，θ = k · 2π / 格数
  let azimuth = atan2(dot(d, normalize(world[0].xz)), dot(d, normalize(world[2].xz)));
  let frames = ${IMPOSTOR_FRAMES};
  let frame = ((i32(round(azimuth / 6.2831853 * f32(frames))) % frames) + frames) % frames;
  let p = middle + (right * corner.x + up * corner.y) * scale;
  let worldPosition = vec4f(effectWorldPosition(windSway(p, world, vec3f(0.0, 0.0, 1.0), uv), mesh.effect), 1.0);
  var out: Varyings;
  out.position = view.viewProjection * worldPosition;
  out.world = worldPosition.xyz;
  out.effect = effectVarying(out.position, worldPosition.xyz, mesh.effect);
  out.normal = facing;
  out.uv = effectUv(mesh.uvTransform.zw + vec2f((f32(frame) + uv.x) / f32(frames), uv.y) * mesh.uvTransform.xy, mesh.effect);
  out.depth = out.position.w;
  out.tangent = vec4f(right, 1.0);
  out.local = vec3f(corner, 0.0);
  out.slot = slot;
  out.skinned = 0u;
  return out;
}

@vertex fn vsImpostor(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32) -> Varyings {
  return impostorVertex(mesh.positionOffset.xyz + position * mesh.positionScale.xyz, normal.xy, uv, slots[instance]);
}

// 运动向量（RenderStage.velocity）：位置和别的阶段一样算（@invariant，深度相等的比较才对得上），另外带上这一帧、上一帧
// 没挪过亚像素的裁剪坐标，片元着色器相减
struct VelocityVaryings {
  @invariant @builtin(position) position: vec4f,
  @location(0) current: vec4f,
  @location(1) previous: vec4f,
};

fn velocityVertex(position: vec3f, normal: vec3f, uv: vec2f, slot: u32, vertex: u32, skin: mat4x4f, previousSkin: mat4x4f) -> VelocityVaryings {
  let now = transformVertex(position, normal, uv, vec4f(0.0), slot, vertex, skin, false);
  var out: VelocityVaryings;
  out.position = now.position;
  out.current = view.unjitteredViewProjection * vec4f(now.world, 1.0);
  out.previous = view.previousViewProjection * previousWorldPosition(position, normal, uv, slot, vertex, previousSkin);
  return out;
}

@vertex fn vsVelocity(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> VelocityVaryings {
  return velocityVertex(position, normal, uv, slots[instance], vertex, IDENTITY, IDENTITY);
}

@vertex fn vsVelocityHeightfield(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> VelocityVaryings {
  let slot = slots[instance];
  let v = heightfieldVertex(position, slot);
  return velocityVertex(v.position, v.normal, v.uv, slot, vertex, IDENTITY, IDENTITY);
}

/** 远处卡片的运动向量：只算相机动了的那部分（卡片自己一帧的转动、摆动很小）。 */
@vertex fn vsVelocityImpostor(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @builtin(instance_index) instance: u32) -> VelocityVaryings {
  let now = impostorVertex(mesh.positionOffset.xyz + position * mesh.positionScale.xyz, normal.xy, uv, slots[instance]);
  var out: VelocityVaryings;
  out.position = now.position;
  out.current = view.unjitteredViewProjection * vec4f(now.world, 1.0);
  out.previous = view.previousViewProjection * vec4f(now.world, 1.0);
  return out;
}

@vertex fn vsVelocitySkinned(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(4) joints: vec4u, @location(5) weights: vec4f, @builtin(instance_index) instance: u32, @builtin(vertex_index) vertex: u32) -> VelocityVaryings {
  let slot = slots[instance];
  return velocityVertex(position, normal, uv, slot, vertex, skinMatrix(slot, joints, weights, false), skinMatrix(slot, joints, weights, true));
}

/** 这个像素上一帧在画面上的位置减这一帧的（UV 单位，y 朝下）。 */
@fragment fn fsVelocity(in: VelocityVaryings) -> @location(0) vec4f {
  let current = in.current.xy / in.current.w;
  let previous = in.previous.xy / in.previous.w;
  return vec4f((previous - current) * vec2f(0.5, -0.5), 0.0, 1.0);
}
`;
