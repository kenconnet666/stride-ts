/** 网格着色器的片元部分：各阶段的片元入口（点选、远处卡片和表面颜色的烘焙、线框、裁剪、抖动的阴影、玻璃透射、主着色、清漆、G 缓冲），面光源、平面反射、透射、室内映射，和把这些合起来的 shade。 */

export const MESH_FRAGMENT = /* wgsl */ `
/** Alpha 裁剪的材质每往下一级 mip，贴图的 alpha 放大多少（Golus 用 0.25）。 */
const ALPHA_MIP_SCALE = 0.25;

/** 背面的法线翻过来朝着相机（Stride 的 MaterialSurfaceLightingAndShading）：两面画的材质背面也按正对着算光照。 */
fn facingNormal(n: vec3f, front: bool) -> vec3f {
  return select(-n, n, front);
}

/**
 * 漫反射的基础色：贴图和颜色按运算符组合。有 Alpha 裁剪的材质（flags.y >= 0）按取的 mip 级把贴图的 alpha 放大（Ben Golus 的
 * "Anti-aliased Alpha Test" 里保覆盖率的做法）：细的叶子、针叶在远处的 mip 里 alpha 被平均得低于阈值，不放大就整片被挖没。
 */
fn baseColor(in: Varyings) -> vec4f {
  var texel = vec4f(1.0);
  if ((u32(material.flags.w) & 1u) != 0u) {
    let uv = in.uv * material.uvTransform.xy + material.uvTransform.zw;
    texel = textureSample(baseColorTexture, baseColorSampler, uv);
    // 矢量贴图（vectorAtlas.ts）：一个屏幕像素不到 1.5 个图集像素（位图开始糊）时按曲线算颜色，到 0.75 以下全用它；远处照旧
    // 用位图。导数在分支外面取（一致的控制流）
    if ((u32(material.flags.w) & 512u) != 0u) {
      let texels = uv * vectorAtlasSize();
      let perPixel = fwidth(texels);
      let footprint = max(perPixel.x, perPixel.y);
      let sharp = saturate((1.5 - footprint) / 0.75);
      if (sharp > 0.0) {
        let vector = vectorColor(uv, perPixel);
        // 矢量是线性、预乘的；没盖满的地方透出位图
        texel = vec4f(mix(texel.rgb, vector.rgb + texel.rgb * (1.0 - vector.a), sharp), texel.a);
      }
    }
    if (material.flags.y >= 0.0) {
      let texels = uv * vec2f(textureDimensions(baseColorTexture));
      let dx = dpdx(texels);
      let dy = dpdy(texels);
      let mip = max(0.5 * log2(max(dot(dx, dx), dot(dy, dy))), 0.0);
      texel.a *= 1.0 + mip * ALPHA_MIP_SCALE;
    }
  }
  return select(texel * material.baseColor, texel + material.baseColor, material.combine == 1u);
}

/**
 * 视差遮挡（Material.normalMap.parallax，Stride 没有）：法线贴图的 alpha 是高度（1 是表面），沿视线在切线空间里一层层往下走，
 * 找到第一层走进高度场里面的，和上一层按两边的高度差线性插值（McGuire 和 McGuire 2005 的 Steep Parallax、Tatarchuk 2006 的 POM；
 * learnopengl 的写法）。切线框架同 surfaceNormal（网格的切线，没有时按屏幕导数现算）；层数按视线和表面的夹角，正对时 steps 的
 * 四分之一、贴着看时 steps。循环里用 textureSampleGrad（导数在循环外按原来的 UV 取，mip 不跳）。没有视差、背面时原样返回。
 */
fn parallaxUv(in: Varyings) -> vec2f {
  let scale = material.normalUvTransform.xy;
  let offset = material.normalUvTransform.zw;
  let dx = dpdx(in.uv * scale);
  let dy = dpdy(in.uv * scale);
  let dp1 = dpdx(in.world);
  let dp2 = dpdy(in.world);
  let duv1 = dpdx(in.uv);
  let duv2 = dpdy(in.uv);
  let depth = material.parallax.x;
  if (depth <= 0.0 || (material.normalFlags & 1u) == 0u) {
    return in.uv;
  }
  let n = normalize(in.normal);
  let dp2perp = cross(dp2, n);
  let dp1perp = cross(n, dp1);
  let ct = dp2perp * duv1.x + dp1perp * duv2.x;
  let cb = dp2perp * duv1.y + dp1perp * duv2.y;
  let frameScale = inverseSqrt(max(max(dot(ct, ct), dot(cb, cb)), 1e-20));
  let tangentLength = length(in.tangent.xyz);
  let hasTangent = tangentLength > 0.0;
  let t = select(ct * frameScale, in.tangent.xyz / max(tangentLength, 1e-8), hasTangent);
  let b = select(cb * frameScale, in.tangent.w * cross(n, t), hasTangent);
  let toEye = normalize(view.eye.xyz - in.world);
  let eye = vec3f(dot(toEye, t), dot(toEye, b), dot(toEye, n));
  if (eye.z <= 0.01) {
    return in.uv;
  }
  let maxLayers = material.parallax.y;
  let layers = mix(maxLayers, max(4.0, maxLayers * 0.25), saturate(eye.z));
  let layerDepth = 1.0 / layers;
  // 每一层 UV 往离开眼睛的方向挪多少：最深处整个挪 eye.xy / eye.z · depth
  let stepUv = eye.xy / eye.z * depth / layers;
  var uv = in.uv;
  var current = 0.0;
  var surface = 1.0 - textureSampleGrad(normalTexture, normalSampler, uv * scale + offset, dx, dy).a;
  for (var i = 0; i < 64 && f32(i) < layers && current < surface; i++) {
    uv -= stepUv;
    current += layerDepth;
    surface = 1.0 - textureSampleGrad(normalTexture, normalSampler, uv * scale + offset, dx, dy).a;
  }
  // 上一层在高度场外面、这一层在里面：按两边离高度场的距离插值
  let previous = uv + stepUv;
  let after = surface - current;
  let before = (1.0 - textureSampleGrad(normalTexture, normalSampler, previous * scale + offset, dx, dy).a) - (current - layerDepth);
  let weight = after / min(after - before, -1e-6);
  return mix(uv, previous, saturate(weight));
}

/** 一个光源照出来的漫反射和镜面反射（分开是因为次表面散射只模糊漫反射）。 */
struct Lit { diffuse: vec3f, specular: vec3f };

/**
 * 卡通着色的渐变（Stride 的 IMaterialCelShadingLightFunction.Compute）：在材质的节点间按 x 线性插值，同一位置的两个节点是台阶，
 * 两头外面取端点的颜色。diffuse 选漫反射还是镜面的那条。
 */
fn celRamp(diffuse: bool, x: f32) -> vec3f {
  let count = u32(select(material.cel.y, material.cel.x, diffuse));
  var previous = select(material.celSpecular[0], material.celDiffuse[0], diffuse);
  if (x <= previous.x) {
    return previous.yzw;
  }
  for (var i = 1u; i < count; i++) {
    let next = select(material.celSpecular[i], material.celDiffuse[i], diffuse);
    if (x < next.x) {
      return mix(previous.yzw, next.yzw, (x - previous.x) / (next.x - previous.x));
    }
    previous = next;
  }
  return previous.yzw;
}

/** 颜色按亮度过渐变、色相不变（Stride 的 IMaterialCelShadingLightFunction.ComputeColor，亮度是 LuminanceUtils.Luma）。 */
fn celColor(diffuse: bool, color: vec3f) -> vec3f {
  let luma = max(dot(color, vec3f(0.299, 0.587, 0.114)), 0.0001);
  return celRamp(diffuse, luma) * color / luma;
}

/** 环境光的漫反射：卡通着色的材质按亮度过渐变（MaterialSurfaceShadingDiffuseCelShading.ComputeEnvironmentLightContribution）。 */
fn celEnvironment(color: vec3f) -> vec3f {
  return select(color, celColor(true, color), material.cel.x > 0.0);
}

/**
 * 面光源每个像素只算一次的部分（光源循环之前，areaShading）：着色点的本地坐标系（法线是 z）、按粗糙度和视角查的 LTC 矩阵和
 * 菲涅耳的缩放偏移。原来每盏灯各查一遍表、各建一遍坐标系，灯一多（超市的天花板 36 盏，一簇平均 23 盏）白算很多遍。
 */
struct AreaShading { frame: mat3x3f, mInv: mat3x3f, specularFrame: mat3x3f, fresnel: vec3f, determinant: f32, reflection: vec3f };

fn areaShading(s: Surface) -> AreaShading {
  let frame = ltcFrame(s.n, s.v);
  var mInv = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
  var fresnel = vec3f(0.0);
  if (s.hasSpecular && localLightData[0].y > 0.5) {
    let table = ltcLookup(sqrt(s.alphaR), s.nDotV);
    let m = table[0];
    mInv = mat3x3f(m.x, 0.0, m.y, 0.0, 1.0, 0.0, m.z, 0.0, m.w);
    fresnel = s.specular * table[1].x + (1.0 - s.specular) * table[1].y;
  }
  return AreaShading(frame, mInv, mInv * frame, fresnel, abs(determinant(mInv)), reflect(-s.v, s.n));
}

/** 离发光面中心超过它半径的这么多倍时漫反射当小光源算（形状因子的误差约 (1 / AREA_FAR)²，1.5% 以内）。 */
const AREA_FAR = 8.0;

/**
 * 矩形光（LTC，Heitz 2016；同 three.js 的 RectAreaLight、虚幻的 Rect Light）：漫反射是余弦分布在矩形上的积分，镜面反射是
 * 按粗糙度和视角查表把 GGX 的波瓣变成余弦再积分，菲涅耳用 Hill 的缩放和偏移。积分的结果是反射出去的亮度（发光面的亮度乘
 * 形状因子），这里的光照最后要乘 π（见 shade），所以先除掉。到中心的距离在射程以内平滑地淡出。查找表还没上传时不画。
 *
 * 省掉的：着色点在发光面背后、或者整盏灯在表面的地平线以下时不算；远处（AREA_FAR 倍半径以外）漫反射按小光源（Snyder）——
 * 立体角 = 面积 · cosθₗ / d²，形状因子 = 立体角 · cosθₛ / π；镜面在灯的张角 ε 里变化不大时也按小光源（LTC 的分布在灯的方向上
 * 的值乘立体角）：分布变化的尺度在波瓣中心附近是粗糙度 α，在尾巴上是灯离反射方向的角度 φ，ε 不到 max(α, φ) 的四分之一时
 * 点近似的误差是 (ε / max(α, φ))² 量级——粗糙的表面、光滑表面上离倒影远的灯都走这条（超市的天花板 36 盏灯，光滑的地面、
 * 货架上只有倒影附近的几盏要积分，镜面那部分 4K 下从 3.2 毫秒降到约 1 毫秒）；倒影附近的照旧积分。矩形按 4 个角单独积分
 * （ltcRect，四个角在本地坐标里只建一次，漫反射、镜面共用），不走 12 个角的数组。
 */
/** 一盏点光、聚光或面光源照到这个像素的漫反射和镜面（乘过直射光的遮蔽 occlusion）；面光源的每像素部分 area 先算好。 */
fn localLightLit(light: LocalLight, surface: Surface, area: AreaShading, world: vec3f, n: vec3f, occlusion: f32) -> Lit {
  let kind = localLightKind(light);
  if (kind >= 2u) {
    let lit = areaLight(surface, area, light, world, kind);
    return Lit(lit.diffuse * occlusion, lit.specular * occlusion);
  }
  let at = localLightAt(light, world);
  let l = at.xyz;
  let attenuation = at.w;
  // 这个视图用不用阴影看图集的尺寸（不用时是 0）
  var shadow = 1.0;
  // 局部光的阴影来自光追时（不透明阶段）不查图集，整体乘可见比例
  let rayTraced = view.decal.z > 0.5 && !TRANSPARENT_STAGE;
  if (light.direction.w >= 0.0 && view.shadowAtlas.y > 0.0 && attenuation > 0.0 && !rayTraced) {
    shadow = computeLocalShadow(u32(light.direction.w), world, n, max(dot(n, l), 0.0001), light.position.xyz);
  }
  return shadeLight(surface, l, light.color.rgb, attenuation, shadow * occlusion);
}

fn areaLight(s: Surface, shading: AreaShading, light: LocalLight, world: vec3f, kind: u32) -> Lit {
  var result = Lit(vec3f(0.0), vec3f(0.0));
  let toLight = light.position.xyz - world;
  let distance2 = dot(toLight, toLight);
  let window = localLightWindow(light, distance2);
  if (localLightData[0].y < 0.5 || window <= 0.0) {
    return result;
  }
  // 发光面的半径（矩形是半对角线，圆盘是 √2 r，管子是半长）
  let extent = sqrt(dot(light.angle.xyz, light.angle.xyz) + select(light.angle.w * light.angle.w, 0.0, kind == 4u));
  // 整盏灯在表面的地平线以下：照不到（漫反射、镜面的波瓣都在上半球）
  if (dot(s.n, toLight) < -extent) {
    return result;
  }
  // 矩形、圆盘只往正面照：着色点在发光面背后
  if (kind != 4u && dot(light.direction.xyz, toLight) >= 0.0) {
    return result;
  }
  let radiance = light.color.rgb * (window / PI);
  // 管状光：一条线段，往四周照
  if (kind == 4u) {
    let halfLength = length(light.angle.xyz);
    let axis = light.angle.xyz / max(halfLength, 1e-6);
    result.diffuse = s.diffuse * radiance * ltcLine(shading.frame, mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0), world, light.position.xyz, axis, halfLength);
    if (s.hasSpecular) {
      result.specular = radiance * shading.fresnel * ltcLine(shading.frame, shading.mInv, world, light.position.xyz, axis, halfLength);
    }
    return result;
  }
  let far = distance2 > AREA_FAR * AREA_FAR * extent * extent;
  let d = sqrt(distance2);
  let l = toLight / d;
  // 面积：矩形 4 · 半宽 · 半高，圆盘按正 12 边形 3r²（同 CPU 定亮度时的面积）
  let area = select(3.0, 4.0, kind == 2u) * light.angle.w * length(light.angle.xyz);
  let solidAngle = area * dot(-l, light.direction.xyz) / distance2;
  // 镜面按小光源：灯的张角 ε = extent / d 不到分布变化尺度 max(α, φ) 的四分之一（φ² ≈ 2 (1 − cos φ)），且灯离得够远（立体角的
  // 公式成立）——LTC 的分布在灯上几乎不变，取中心的值乘立体角
  let scale2 = max(s.alphaR * s.alphaR, 2.0 * (1.0 - dot(shading.reflection, l)));
  let pointSpecular = !s.hasSpecular || (distance2 > 16.0 * extent * extent && scale2 * distance2 > 16.0 * extent * extent);
  // 矩形要积分时（漫反射近、或者镜面要积分）四个角只建一次
  var corners = RectCorners(vec3f(0.0), vec3f(0.0), vec3f(0.0), vec3f(0.0));
  if (kind == 2u && (!far || !pointSpecular)) {
    corners = rectCorners(shading.frame, toLight, light);
  }
  if (far) {
    result.diffuse = s.diffuse * radiance * (solidAngle * max(dot(s.n, l), 0.0) / PI);
  } else if (kind == 2u) {
    result.diffuse = s.diffuse * radiance * ltcRect(corners);
  } else {
    // 圆盘的漫反射很糊、看不出边，按正 6 边形算（面积 2.598r²，乘 3 / 2.598 补成正 12 边形的）
    result.diffuse = s.diffuse * radiance * 1.1547005 * ltcPolygon(shading.frame, world, areaLightPolygon(light, kind, 6u));
  }
  if (!s.hasSpecular) {
    return result;
  }
  if (pointSpecular) {
    let w = shading.specularFrame * l;
    let length2 = dot(w, w);
    let lobe = max(w.z, 0.0) * inverseSqrt(length2) / PI * shading.determinant / (length2 * sqrt(length2));
    result.specular = radiance * shading.fresnel * (lobe * solidAngle);
  } else if (kind == 2u) {
    let m = shading.mInv;
    result.specular = radiance * shading.fresnel * ltcRect(RectCorners(m * corners.a, m * corners.b, m * corners.d, m * corners.e));
  } else {
    // 镜面反射按正 12 边形，亮面上的倒影是圆的
    result.specular = radiance * shading.fresnel * ltcPolygon(shading.specularFrame, world, areaLightPolygon(light, kind, AREA_CORNERS));
  }
  return result;
}

/**
 * 平面反射（PlanarReflections）：在影响盒子里、法线朝着平面法线的表面，取镜像画面同一个屏幕位置（u 翻回来）的颜色；法线偏离
 * 平面法线的部分按扭曲挪一点（水面、不平的地砖），粗糙的取模糊的 mip。a 是权重：盒子边上、法线偏得多的淡出。
 */
fn planarSpecular(world: vec3f, fragment: vec2f, n: vec3f, roughness: f32) -> vec4f {
  let box = (view.planarToBox * vec4f(world, 1.0)).xyz;
  let facing = dot(n, view.planarNormal.xyz);
  let edge = 1.0 - max(abs(box.x), abs(box.z));
  if (abs(box.y) > 1.0 || edge <= 0.0 || facing < 0.6) {
    return vec4f(0.0);
  }
  let tilt = (view.viewProjection * vec4f(n - view.planarNormal.xyz * facing, 0.0)).xy * vec2f(-0.5, -0.5) * view.planarNormal.w;
  let uv = vec2f(1.0 - fragment.x * view.planar.z, fragment.y * view.planar.w) + tilt;
  let color = planarColor(uv, roughness * view.planar.y * 0.6) * view.planarIntensity.x;
  return vec4f(color, saturate(edge * 8.0) * smoothstep(0.6, 0.9, facing));
}

/**
 * 透射过来的光（Material.transmission，照 Filament 的 evaluateRefraction）：沿折射光线找出射点——薄的面（厚度 0）就是这一点、
 * 方向不变；实心的按球近似（Filament 的 refractionSolidSphere：进去折一次，在里面走厚度那么远，按球面的法线再折出来）——投到
 * 屏幕上取折射拷的画面（粗糙的取模糊的级）；这个视图没有那份画面、或者出射点出了屏幕时取出射方向上的环境。走过的距离按吸收衰减。
 */
fn transmittedLight(world: vec3f, n: vec3f, v: vec3f, perceptualRoughness: f32, cluster: i32) -> vec3f {
  let ior = material.transmission.y;
  let etaIR = 1.0 / ior;
  let thickness = material.transmission.z;
  var position = world;
  var direction = -v;
  var distance = 0.0;
  if (thickness > 0.0) {
    let inside = refract(-v, n, etaIR);
    let nDotR = dot(n, inside);
    distance = thickness * -nDotR;
    position = world + inside * distance;
    let exitNormal = normalize(nDotR * inside - n * 0.5);
    direction = refract(inside, exitNormal, ior);
    // 全反射时 refract 是 0：按里面的方向走
    if (dot(direction, direction) < 1e-6) {
      direction = inside;
    }
  }
  // 折射率接近 1 的没有微表面的糊（Filament 的重映射：1 时不糊，1.5 时按粗糙度糊）
  let roughness = mix(perceptualRoughness, 0.0, saturate(etaIR * 3.0 - 2.0));
  var color = vec3f(0.0);
  var onScreen = false;
  if (TRANSPARENT_STAGE && view.decal.y > 0.0) {
    let clip = view.viewProjection * vec4f(position, 1.0);
    let uv = vec2f(clip.x, -clip.y) / clip.w * 0.5 + 0.5;
    if (clip.w > 0.0 && all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))) {
      // 取哪级照 Filament（2·log2(粗糙度) 加偏移，乘 1/log2(√5)），偏移取最粗的级（约 log2 画面尺寸）：光滑的清楚，磨砂的糊得开
      let level = max(0.0, (2.0 * log2(max(roughness, 1e-3)) + view.decal.y - 1.0) * 0.8614);
      color = sceneColor(uv, level);
      onScreen = true;
    }
  }
  if (!onScreen) {
    color = environmentRadiance(position, direction, roughness, cluster);
  }
  return color * exp(-material.absorption.rgb * distance);
}

/** 一个方向上的环境光（反射探针盖住的用它，剩下的用环境光颜色和天空盒），roughness 是感知的粗糙度。 */
fn environmentRadiance(world: vec3f, direction: vec3f, roughness: f32, cluster: i32) -> vec3f {
  var probe = vec4f(0.0);
  if (view.locals.w > 0.0) {
    probe = probeSpecular(world, direction, roughness, cluster);
  }
  var color = probe.rgb + view.ambientColor.rgb * (1.0 - probe.a);
  if (view.sky.x > 0.0) {
    color += textureSampleLevel(skySpecular, linearClamp, skyDirection(direction), roughness * view.sky.y).rgb * view.sky.x * (1.0 - probe.a);
  }
  return color;
}

/**
 * 薄膜干涉（glTF 的 KHR_materials_iridescence、OpenPBR 的 thin film；Belcour 和 Barla 2017 的薄膜模型，写法同 glTF Sample Viewer 的
 * iridescence）：空气 - 膜 - 底层两个界面反射的光按光程差（膜厚 × 折射率 × 视角）相消相长，只算前两阶干涉，光谱灵敏度用高斯拟合。
 * 返回垂直入射换算以前的菲涅耳反射（RGB）；baseF0 是底层的 F0。
 */
const XYZ_TO_REC709 = mat3x3f(
  vec3f(3.2404542, -0.9692660, 0.0556434),
  vec3f(-1.5371385, 1.8760108, -0.2040259),
  vec3f(-0.4985314, 0.0415560, 1.0572252));

fn iridescenceFresnel0(transmittedIor: vec3f, incidentIor: f32) -> vec3f {
  let r = (transmittedIor - vec3f(incidentIor)) / (transmittedIor + vec3f(incidentIor));
  return r * r;
}

fn iridescenceSensitivity(opd: f32, shift: vec3f) -> vec3f {
  let phase = 2.0 * PI * opd * 1.0e-9;
  let amplitude = vec3f(5.4856e-13, 4.4201e-13, 5.2481e-13);
  let position = vec3f(1.6810e+06, 1.7953e+06, 2.2084e+06);
  let variance = vec3f(4.3278e+09, 9.3046e+09, 6.6121e+09);
  var xyz = amplitude * sqrt(2.0 * PI * variance) * cos(position * phase + shift) * exp(-phase * phase * variance);
  xyz.x += 9.7470e-14 * sqrt(2.0 * PI * 4.5282e+09) * cos(2.2399e+06 * phase + shift.x) * exp(-4.5282e+09 * phase * phase);
  return XYZ_TO_REC709 * (xyz / 1.0685e-7);
}

fn iridescenceFresnel(outsideIor: f32, filmIor: f32, cosTheta1: f32, thickness: f32, baseF0: vec3f) -> vec3f {
  // 膜厚趋近 0 时膜的折射率退回外面的（没有膜）
  let iridescenceIor = mix(outsideIor, filmIor, smoothstep(0.0, 0.03, thickness));
  let ratio = outsideIor / iridescenceIor;
  let cosTheta2Sq = 1.0 - ratio * ratio * (1.0 - cosTheta1 * cosTheta1);
  if (cosTheta2Sq < 0.0) { return vec3f(1.0); }
  let cosTheta2 = sqrt(cosTheta2Sq);
  let first = iridescenceFresnel0(vec3f(iridescenceIor), outsideIor).x;
  let r12 = first + (1.0 - first) * pow(1.0 - cosTheta1, 5.0);
  let t121 = 1.0 - r12;
  let phi12 = select(0.0, PI, iridescenceIor < outsideIor);
  let phi21 = PI - phi12;
  let rootF0 = sqrt(clamp(baseF0, vec3f(0.0), vec3f(0.9999)));
  let baseIor = (vec3f(1.0) + rootF0) / (vec3f(1.0) - rootF0);
  let second = iridescenceFresnel0(baseIor, iridescenceIor);
  let r23 = second + (vec3f(1.0) - second) * pow(1.0 - cosTheta2, 5.0);
  let phi23 = select(vec3f(0.0), vec3f(PI), baseIor < vec3f(iridescenceIor));
  let opd = 2.0 * iridescenceIor * thickness * cosTheta2;
  let phi = vec3f(phi21) + phi23;
  let r123 = clamp(r12 * r23, vec3f(1e-5), vec3f(0.9999));
  let root = sqrt(r123);
  let rs = (t121 * t121) * r23 / (vec3f(1.0) - r123);
  var intensity = vec3f(r12) + rs;
  var term = rs - vec3f(t121);
  for (var m = 1; m <= 2; m++) {
    term *= root;
    intensity += term * 2.0 * iridescenceSensitivity(f32(m) * opd, f32(m) * phi);
  }
  return max(intensity, vec3f(0.0));
}

/**
 * 一个光源的直射光：Lambert 漫反射加微表面镜面（默认菲涅耳 Schlick、GGX、Smith-Schlick-GGX，材质可以换，见 Surface.microfacet；
 * Stride 的 MaterialSurfaceShadingDiffuseLambert、SpecularMicrofacet），卡通着色的材质两项各过渐变。l 是指向光源的单位向量；
 * attenuation 是距离、角度衰减，visibility 是阴影乘遮蔽（卡通着色只让衰减进渐变）。
 */
fn shadeLight(s: Surface, l: vec3f, lightColor: vec3f, attenuation: f32, visibility: f32) -> Lit {
  let nDotL = max(dot(s.n, l), 0.0001);
  let lightColorNdotL = lightColor * (attenuation * visibility * nDotL);
  var diffuseLight = lightColorNdotL;
  if (material.cel.x > 0.0) {
    // MaterialSurfaceShadingDiffuseCelShading：N·L 乘衰减（FakeNDotL 大于 0 时再乘它）过渐变，替代 N·L 和衰减
    let fake = material.cel.z;
    diffuseLight = celRamp(true, nDotL * attenuation * select(1.0, fake, fake > 0.0)) * lightColor * visibility;
  }
  var result = Lit(s.diffuse / PI * diffuseLight, vec3f(0.0));
  let hasSheen = any(s.sheenColor > vec3f(0.0));
  if (!s.hasSpecular && !hasSheen) {
    return result;
  }
  let h = normalize(s.v + l);
  let nDotH = saturate(dot(s.n, h));
  if (s.hasSpecular) {
    let lDotH = saturate(dot(l, h));
    // 玻璃的菲涅耳项就是它的反射比例（MaterialSpecularMicrofacetFresnelThinGlass），放在 s.specular 里；菲涅耳为 none 时就是 f0
    let fresnel = select(s.specular + (1.0 - s.specular) * pow(1.0 - lDotH, 5.0), s.specular, s.glass || (s.microfacet & 1u) != 0u);
    if (s.anisotropy != 0.0) {
      // 各向异性（Filament）：切线、副切线方向的粗糙度不同，可见性用相关的 Smith（已经含 1 / (4 · N·L · N·V)）
      let at = max(s.alphaR * (1.0 + s.anisotropy), 0.001);
      let ab = max(s.alphaR * (1.0 - s.anisotropy), 0.001);
      let d = distributionGGXAnisotropic(at, ab, dot(s.t, h), dot(s.b, h), nDotH);
      let visibility = visibilityGGXAnisotropic(at, ab, dot(s.t, s.v), dot(s.b, s.v), dot(s.t, l), dot(s.b, l), s.nDotV, nDotL);
      result.specular = fresnel * d * visibility * lightColorNdotL;
    } else {
      let d = microfacetDistribution((s.microfacet >> 1u) & 3u, s.alphaR, nDotH);
      let geometric = microfacetVisibility((s.microfacet >> 3u) & 7u, s.alphaR, nDotL, s.nDotV, nDotH, dot(s.v, h));
      let reflected = fresnel * geometric * d / 4.0;
      // 卡通着色（MaterialSurfaceShadingSpecularCelShading）：反射的那部分按亮度过渐变
      result.specular = select(reflected, celColor(false, reflected), material.cel.y > 0.0) * lightColorNdotL;
    }
  }
  if (hasSheen) {
    // 光泽在底下那层的上面：底下的镜面按光泽反射走的能量变暗（漫反射在 s.diffuse 里已经乘过）
    result.specular = result.specular * s.sheenScaling + s.sheenColor * distributionCharlie(s.sheenAlpha, nDotH) * visibilityNeubelt(s.nDotV, nDotL) * lightColorNdotL;
  }
  return result;
}

/** 点选的编号缓冲：写实例的变换槽位加一（0 留给"什么都没有"）；Alpha 裁剪掉的像素点不到。 */
@fragment fn fsPick(in: Varyings) -> @location(0) u32 {
  let base = baseColor(in);
  if (base.a < material.flags.y) {
    discard;
  }
  return in.slot + 1u;
}

struct ImpostorBakeOutput {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
};

/**
 * 烘远处卡片（RenderStage.impostor）：漫反射色（材质层混过的，Alpha 裁剪掉的像素丢掉，没有裁剪时按 0.5），和视图空间里的法线
 * （右、上、朝相机，映射到 0..1）加粗糙度。视图是正交的：视图投影的前两行就是视图的右、上。
 */
@fragment fn fsImpostorBake(in: Varyings, @builtin(front_facing) front: bool) -> ImpostorBakeOutput {
  let base = baseColor(in);
  if (base.a * material.blend.a < select(0.5, material.flags.y, material.flags.y >= 0.0)) {
    discard;
  }
  let n = facingNormal(surfaceNormal(in, false), front);
  let layers = materialLayers(in, LayerSurface(base.rgb, material.surface.x, material.specularColor.rgb, material.surface.y));
  let vp = view.viewProjection;
  let right = normalize(vec3f(vp[0][0], vp[1][0], vp[2][0]));
  let up = normalize(vec3f(vp[0][1], vp[1][1], vp[2][1]));
  let m = vec3f(dot(n, right), dot(n, up), dot(n, cross(right, up)));
  return ImpostorBakeOutput(vec4f(layers.albedo, 1.0), vec4f(m * 0.5 + 0.5, layers.roughness));
}

struct SurfaceBakeOutput {
  @location(0) albedo: vec4f,
  @location(1) emissive: vec4f,
};

/**
 * 表面颜色的烘焙（RenderStage.surfaceBake）：漫反射色（材质层混过的，金属的部分不算漫反射）和自发光，a 是 1（没盖到的像素清成 0，
 * 求平均时只算盖到的）。Alpha 裁剪掉的像素丢掉。
 */
@fragment fn fsSurfaceBake(in: Varyings) -> SurfaceBakeOutput {
  let base = baseColor(in);
  if (base.a * material.blend.a < select(0.5, material.flags.y, material.flags.y >= 0.0)) {
    discard;
  }
  let layers = materialLayers(in, LayerSurface(base.rgb, material.surface.x, material.specularColor.rgb, material.surface.y));
  return SurfaceBakeOutput(vec4f(layers.albedo * (1.0 - layers.metalness), 1.0), vec4f(emissiveColor(in).rgb, 1.0));
}

struct WireOutput {
  @location(0) color: vec4f,
  @builtin(frag_depth) depth: f32,
};

/**
 * 线框：一个固定的浅色。线和它所在的三角形深度几乎一样，直接比会一段有一段没有，所以把深度往相机这边挪一点再比
 * （WebGPU 不许给线的管线设深度偏移，在这里改写出去的深度；线框的管线不写深度缓冲）。
 */
@fragment fn fsWire(in: Varyings) -> WireOutput {
  return WireOutput(vec4f(0.75, 0.9, 1.0, 1.0), in.position.z * 0.9995);
}

/**
 * 只写深度的阶段里丢掉被裁的像素：Alpha 裁剪按材质的阈值；关了抖动阴影的透明混合同 Stride 丢掉 alpha 小于 0.1 的
 * （matAlphaDiscard 的默认值；没有裁剪时 flags.y 是 -1）。
 */
@fragment fn fsCutout(in: Varyings) {
  let threshold = select(0.1, material.flags.y, material.flags.y >= 0.0);
  if (baseColor(in).a * material.blend.a < threshold) {
    discard;
  }
}

/** 4x4 的 Bayer 矩阵，同 Stride 的 ShadowMapCasterAlphaDithered。 */
const BAYER_4X4 = array<f32, 16>(
  0.0, 0.53333336, 0.13333334, 0.6666667,
  0.8, 0.26666668, 0.9333333, 0.4,
  0.2, 0.73333335, 0.06666667, 0.6,
  1.0, 0.4666667, 0.8666667, 0.33333334);

/**
 * 透明混合的材质投阴影：按 alpha 在阴影图上抖动着丢像素（同 Stride 的 ShadowMapCasterAlphaDithered），PCF 一滤就是半透明的影子。
 * alpha 同颜色那一遍（漫反射的 alpha 乘透明的系数）。
 */
@fragment fn fsDitheredShadow(in: Varyings) {
  let alpha = saturate(baseColor(in).a * material.blend.a);
  let cell = vec2u(in.position.xy) % 4u;
  if (-1.01 + BAYER_4X4[cell.x + cell.y * 4u] + alpha * 1.01 < 0.0) {
    discard;
  }
}

/** 玻璃透射的那一遍（Stride 的 MaterialSurfaceTransmittanceShading）：输出的颜色乘到背景上（混合是 目标 × 源）。 */
@fragment fn fsGlassTransmittance(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let n = facingNormal(surfaceNormal(in, false), front);
  let v = normalize(view.eye.xyz - in.world);
  let base = baseColor(in);
  let glass = thinGlass(base.rgb, max(dot(n, v), 0.0001), material.flags.z);
  return vec4f(mix(vec3f(1.0), glass.transmittance, saturate(base.a * material.blend.a)), 1.0);
}

@fragment fn fs(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return shade(in, front, false).color;
}

/** 清漆叠在上面的那一遍（透明阶段，加到画面上）。 */
@fragment fn fsClearCoat(in: Varyings, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  return shade(in, front, true).color;
}

struct SurfaceOutput {
  @location(0) color: vec4f,
  @location(1) normalRoughness: vec4f,
  @location(2) specularWeight: vec4f,
  @location(3) environment: vec4f,
};

/** 不透明阶段给屏幕空间反射留下表面（RenderOutput.surfaceFormats、SURFACE_FORMATS）。 */
@fragment fn fsSurface(in: Varyings, @builtin(front_facing) front: bool) -> SurfaceOutput {
  let s = shade(in, front, false);
  // 第 3 张表面的 a：次表面散射的槽位 + 强度（强度的小数部分到 0.99 为止，整数部分不会进位）。散射材质的 rgb 换成颜色里
  // 不散射的部分（镜面反射、自发光），模糊时只糊剩下的漫反射光；这些像素不做屏幕空间反射
  let scatters = material.subsurface.x > 0.0;
  let scattering = select(0.0, material.subsurface.x + clamp(material.subsurface.y, 0.0, 0.99), scatters);
  let kept = select(s.environment, s.color.rgb - s.scattered, scatters);
  return SurfaceOutput(s.color, vec4f(octahedralEncode(s.normal), s.roughness, 1.0), vec4f(s.specularWeight, 1.0), vec4f(kept, scattering));
}

/** 单位向量的八面体编码（-1..1 的两个数）：法线放进两个通道，比存 xyz 少一个通道、精度均匀。 */
fn octahedralEncode(n: vec3f) -> vec2f {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  return select(p, (1.0 - abs(p.yx)) * select(vec2f(-1.0), vec2f(1.0), p >= vec2f(0.0)), n.z < 0.0);
}

/** 一个像素着色的结果：颜色，和屏幕空间反射要的表面（SURFACE_FORMATS）。 */
struct Shaded {
  color: vec4f,
  normal: vec3f,
  roughness: f32,
  /** 环境镜面反射的权重（镜面颜色乘 DFG）。 */
  specularWeight: vec3f,
  /** 加进颜色里的环境镜面反射。 */
  environment: vec3f,
  /** 加进颜色里的漫反射光（直射、环境、天空、屏幕空间的间接光）。 */
  scattered: vec3f,
};

/** 一个像素的光照；coatPass 为真时是清漆的那一遍。 */
/**
 * 室内映射（Material.interior；Joost van Dongen 2008 的 Interior Mapping，Spider-Man、黑客帝国觉醒的城市都这么做）：玻璃后面按
 * 世界坐标排一间间房间（宽、高、深），沿视线算看到房间里的哪一面（后墙、侧墙、地板、天花板），不加几何。房间按格子哈希出墙色、
 * 有没有一件靠墙的家具、亮不亮灯（亮的发暖光）；没亮的房间按窗外进来的天光（天空的球谐、环境光）照亮，越往里越暗。只有竖直的
 * 面有（穹顶这种斜的玻璃没有）。返回从玻璃这一点看进去的光（线性），着色时乘透过的比例（1 − 反射）。
 */
fn interiorLight(world: vec3f, n: vec3f) -> vec3f {
  let room = material.interior.xyz;
  if (room.x <= 0.0 || abs(n.y) > 0.3) {
    return vec3f(0.0);
  }
  let inward = -normalize(vec3f(n.x, 0.0, n.z));
  let along = vec3f(-inward.z, 0.0, inward.x);
  // 房间的格子按世界坐标排（加上渲染原点取模的部分：原点换了不跳），射线换到房间的坐标里：u 沿墙、v 往上、w 往里
  let p = world + view.origin.xyz;
  let d = normalize(world - view.eye.xyz);
  let du = dot(d, along);
  let dv = d.y;
  let dw = max(dot(d, inward), 1e-4);
  let cell = floor(vec2f(dot(p, along), p.y) / room.xy);
  let local = vec2f(dot(p, along), p.y) - cell * room.xy;
  let big = 1e6;
  let tu = select(select((room.x - local.x) / du, -local.x / du, du < 0.0), big, abs(du) < 1e-5);
  let tv = select(select((room.y - local.y) / dv, -local.y / dv, dv < 0.0), big, abs(dv) < 1e-5);
  let tw = room.z / dw;
  let t = min(min(tu, tv), tw);
  let hit = vec3f(local + vec2f(du, dv) * t, dw * t);
  let random = hash3(vec3i(i32(cell.x), i32(cell.y), i32(round(dot(p, -inward) * 2.0))));
  // 墙色：暖白、米色、浅灰里挑一个；地板深一点；天花板白
  let wall = mix(vec3f(0.62, 0.58, 0.52), vec3f(0.72, 0.7, 0.68), random.x) * mix(0.75, 1.0, random.y);
  var albedo = wall;
  if (t == tv) {
    albedo = select(vec3f(0.8, 0.8, 0.78), vec3f(0.3, 0.24, 0.18) * (0.7 + 0.6 * random.z), dv < 0.0);
  } else if (t == tu) {
    albedo = wall * 0.85;
  } else {
    // 后墙前面一件矮家具（柜子、沙发的剪影）：按房间随机的位置和宽度
    let start = random.z * 0.6 * room.x;
    if (hit.y < room.y * 0.38 && hit.x > start && hit.x < start + room.x * 0.35) {
      albedo = vec3f(0.18, 0.15, 0.13);
    }
  }
  // 窗外进来的天光（朝外看的那一半天空），越往里越暗；亮灯的房间加暖光，靠天花板亮一点
  var light = (view.ambientColor.rgb + select(vec3f(0.0), evaluateSH(skyDirection(-inward)) * view.sky.x, view.sky.x > 0.0)) * 0.35;
  light *= mix(1.0, 0.35, saturate(hit.z / room.z));
  if (random.y < material.interior.w) {
    light += vec3f(1.0, 0.82, 0.6) * material.interiorLight.x * (0.7 + 0.3 * saturate(hit.y / room.y));
  }
  return albedo * light;
}

fn shade(raw: Varyings, front: bool, coatPass: bool) -> Shaded {
  // 视差遮挡：后面所有贴图、节点图都按移过的 UV 取
  var in = raw;
  in.uv = parallaxUv(raw);
  var n = facingNormal(surfaceNormal(in, coatPass), front);
  let v = normalize(view.eye.xyz - in.world);
  let base = baseColor(in);
  if (base.a < material.flags.y) {
    discard;
  }
  // 粗糙度：常量，或者光泽度贴图的一个通道（没有贴图时 mask 是 0，取常量）
  let hasGlossTexture = dot(material.glossinessMask, vec4f(1.0)) > 0.0;
  var glossTexel = 0.0;
  var metalnessScale = 1.0;
  var transmissionScale = 1.0;
  if (hasGlossTexture) {
    let texel = textureSample(glossinessTexture, glossinessSampler, in.uv * material.glossinessUvTransform.xy + material.glossinessUvTransform.zw);
    glossTexel = dot(texel, material.glossinessMask);
    // 同一张贴图里的金属度（不用动态下标取向量的分量：DXC 会先存进局部数组）
    let metalnessChannel = (u32(material.flags.w) >> 3u) & 7u;
    if (metalnessChannel > 0u) {
      metalnessScale = dot(texel, select(vec4f(0.0), vec4f(1.0), vec4u(1u, 2u, 3u, 4u) == vec4u(metalnessChannel)));
    }
    // 透射的比例也可以按这张贴图的一个通道分区域（瓶身透、标签不透）
    let transmissionChannel = (u32(material.flags.w) >> 6u) & 7u;
    if (transmissionChannel > 0u) {
      transmissionScale = dot(texel, select(vec4f(0.0), vec4f(1.0), vec4u(1u, 2u, 3u, 4u) == vec4u(transmissionChannel)));
    }
  }
  // 材质层按遮罩混进各个属性（没有层时原样）
  let layers = materialLayers(in, LayerSurface(base.rgb, material.surface.x * metalnessScale, material.specularColor.rgb,
    select(material.surface.y, select(1.0 - glossTexel, glossTexel, material.flags.x > 0.5), hasGlossTexture)));
  // 清漆把漫反射色、金属度、粗糙度换成这一遍的（没有清漆时原样）
  // 贴花盖在材质上，天气（湿、雪）再盖在贴花上
  let cluster = clusterOf(in.position, in.world);
  let decaled = applyDecals(in.world, n, coatSurface(in, layers, coatPass), cluster);
  n = decaled.normal;
  // 水洼的水面是平的（下雨时有涟漪）：天气也可能换法线
  let weathered = weatherSurface(in.world, n, facingNormal(normalize(in.normal), front), in.skinned != 0u, decaled.surface);
  n = weathered.normal;
  let layered = weathered.surface;
  let albedo = layered.albedo;

  // 金属度工作流（MaterialSurfaceMetalness）或镜面颜色（MaterialSpecularMapFeature），再乘 cavity 和透明的 alpha、tint
  // （PrepareMaterialForLightingAndShading；镜面项的 alpha 是 matDiffuseSpecularAlphaBlend.y）
  // material.specular 的低两位是工作流（0 没有，1 金属度，2 镜面颜色，3 镜面颜色且能量守恒）；第 3 位（4）表示没有镜面着色模型：
  // 不画镜面反射，可见的镜面色（matSpecularVisible）照常算，只用来折进漫反射；第 4 位（8）表示没有漫反射着色模型：不算漫反射光照
  let workflow = material.specular & 3u;
  let hasSpecular = workflow != 0u && (material.specular & 4u) == 0u;
  let metalness = layered.metalness;
  let isMetalness = workflow == 1u;
  let f0 = select(layered.specular, mix(vec3f(0.02), albedo, metalness), isMetalness);
  let visibleSpecular = select(vec3f(0.0), f0, workflow != 0u) * material.surface.w * material.blend.rgb * material.emissive.w;
  let plainSpecular = select(vec3f(0.0), visibleSpecular, hasSpecular);
  // 镜面颜色工作流默认能量守恒（Stride 的 IsEnergyConservative：MaterialSurfaceShadingDiffuseLambert 的漫反射乘 1 - 镜面）
  let conserved = select(vec3f(1.0), 1.0 - visibleSpecular, workflow == 3u);
  let litDiffuse = select(albedo, albedo * (1.0 - metalness), isMetalness) * material.surface.z * material.blend.rgb * material.blend.a * conserved;
  let baseDiffuse = select(litDiffuse, vec3f(0.0), (material.specular & 8u) != 0u);
  // 环境光遮蔽：环境光全乘，直射光乘 lerp(1, ao, 直射光受影响的程度)；材质层可以把这两个数换成自己的
  var occlusionBase = material.occlusionMask.x;
  if ((u32(material.flags.w) & 4u) != 0u) {
    occlusionBase = dot(textureSample(occlusionTexture, occlusionSampler, in.uv * material.occlusionUvTransform.xy + material.occlusionUvTransform.zw), material.occlusionMask);
  }
  let occlusion = layerOcclusion(in, vec2f(occlusionBase, material.occlusionDirect));
  // 屏幕空间的遮蔽只算进环境光（直射光的遮蔽是有没有影子，不归它管）
  let screen = screenAmbient(in.position);
  let ao = occlusion.x * screen.w;
  let directOcclusion = mix(1.0, occlusion.x, occlusion.y);
  let roughness = layered.roughness;
  let alphaR = max(roughness * roughness, 0.001);
  let nDotV = max(dot(n, v), 0.0001);
  // 薄膜干涉：镜面反射的 F0 换成这个视角的干涉色（glTF Sample Viewer：先算菲涅耳，再按 Schlick 反推 F0）
  var specular = plainSpecular;
  if (hasSpecular && material.iridescence.x > 0.0) {
    let fresnel = iridescenceFresnel(1.0, material.iridescence.y, nDotV, material.iridescence.z, plainSpecular);
    let x5 = pow(1.0 - nDotV, 5.0);
    let iridescentF0 = clamp((fresnel - vec3f(x5)) / max(1.0 - x5, 1e-4), vec3f(0.0), vec3f(1.0));
    specular = mix(plainSpecular, iridescentF0, material.iridescence.x);
  }

  // 扩展材质（Stride 没有）：光泽在底下那层的上面，底下那层按光泽反射走的能量（查找表的 z）变暗
  let sheenColor = material.sheen.rgb;
  let sheenRoughness = clamp(material.sheen.w, 0.07, 1.0);
  var sheenDfg = 0.0;
  if (any(sheenColor > vec3f(0.0))) {
    sheenDfg = dfgLookup(vec2f(1.0 - sheenRoughness, nDotV)).z;
  }
  let sheenScaling = 1.0 - max(sheenColor.r, max(sheenColor.g, sheenColor.b)) * sheenDfg;
  // 透射的那部分光穿过去了，不走漫反射（Filament：Fd *= 1 - transmission）
  let transmission = material.transmission.x * transmissionScale;
  // 漫透射：正面的漫反射让出一部分，从背面的光里透出来（树叶、纸、灯罩）
  let thinFactor = material.diffuseTransmission.w;
  let diffuse = baseDiffuse * sheenScaling * (1.0 - transmission) * (1.0 - thinFactor);
  let backDiffuse = baseDiffuse * sheenScaling * (1.0 - transmission) * thinFactor * material.diffuseTransmission.rgb;
  // 各向异性的方向：顶点切线（没有时按贴图坐标的导数算），转材质给的角度。导数在按材质常量的分支里取（一致的控制流）
  let anisotropy = clamp(material.anisotropy.x, -0.99, 0.99);
  var anisotropicT = vec3f(1.0, 0.0, 0.0);
  var anisotropicB = vec3f(0.0, 0.0, 1.0);
  if (anisotropy != 0.0) {
    let derived = derivativeTangent(in.world, in.uv, n);
    let vertexTangent = dot(in.tangent.xyz, in.tangent.xyz) > 1e-12;
    var t = select(derived, in.tangent.xyz, vertexTangent);
    t = normalize(t - n * dot(n, t) + vec3f(1e-6, 0.0, 0.0));
    let b = cross(n, t) * select(1.0, in.tangent.w, vertexTangent && in.tangent.w != 0.0);
    anisotropicT = normalize(t * material.anisotropy.y + b * material.anisotropy.z);
    anisotropicB = normalize(cross(n, anisotropicT));
  }
  // 环境光的反射方向：各向异性时按 Filament 把法线往"沿拉长方向的法线"弯过去
  var reflection = reflect(-v, n);
  if (anisotropy != 0.0) {
    let direction = select(anisotropicT, anisotropicB, anisotropy >= 0.0);
    let bentNormal = normalize(mix(n, cross(cross(direction, v), direction), abs(anisotropy)));
    reflection = reflect(-v, bentNormal);
  }

  // 直射光（DirectLightGroup.PrepareDirectLight：光色 · 衰减 · 阴影 · N·L），逐个光源相加
  // 玻璃：镜面的菲涅耳项和环境光的镜面系数都换成它的反射比例（Stride 的 FresnelThinGlass、EnvironmentThinGlass）
  let isGlass = material.flags.z > 0.0;
  // 不是玻璃的材质不算（里面有三次 pow，每个像素都算的话是这个着色器里最贵的一段）
  var glass = Glass(vec3f(1.0), vec3f(0.0));
  if (isGlass) {
    glass = thinGlass(base.rgb, nDotV, material.flags.z);
  }
  // 微表面模型的各项在 material.specular 的第 4 位往上（MeshRenderFeature 的 microfacetBits）
  let microfacet = material.specular >> 4u;
  let surface = Surface(n, v, diffuse, select(specular, glass.reflectance, isGlass), hasSpecular, isGlass, alphaR, nDotV,
    sheenColor, sheenRoughness * sheenRoughness, sheenScaling, anisotropy, anisotropicT, anisotropicB, microfacet);
  var direct = Lit(vec3f(0.0), vec3f(0.0));
  // 次表面散射的材质（有槽位）算透射
  let scatters = material.subsurface.x > 0.0;
  let lightCount = u32(view.sky.z);
  let shadowLight = i32(view.sky.w);
  for (var i = 0u; i < lightCount; i++) {
    let l = -view.lightDirections[i].xyz;
    var shadow = 1.0;
    if (i32(i) == shadowLight) {
      shadow = computeShadow(in.world, n, max(dot(n, l), 0.0001), in.depth, in.position.xy) * screenContactShadow(in.position);
      // 和 Stride 不同：没有阴影图的光不算透射（不知道厚度；Stride 当厚度是 0，被照到的地方都透亮）
      if (scatters && view.shadow.x > 0.0) {
        direct.diffuse += transmittance(shadowThickness(in.world, n, in.depth), n, l, view.lightColors[i].rgb * directOcclusion, diffuse);
      }
    }
    if (i32(i) == i32(view.cloudShadow.w)) { shadow *= cloudShadow(in.world, l); }
    let lit = shadeLight(surface, l, view.lightColors[i].rgb, 1.0, shadow * directOcclusion);
    direct.diffuse += lit.diffuse;
    direct.specular += lit.specular;
    if (thinFactor > 0.0) {
      // 背面的光：阴影按反面的法线取（薄叶子在自己的阴影图里不能把自己遮住）
      var backShadow = 1.0;
      if (i32(i) == shadowLight) {
        backShadow = computeShadow(in.world, -n, max(dot(-n, l), 0.0001), in.depth, in.position.xy);
      }
      direct.diffuse += backDiffuse / PI * view.lightColors[i].rgb * (backShadow * directOcclusion * max(dot(-n, l), 0.0));
    }
  }
  // 点光、聚光：距离衰减（LightUtil.GetDistanceAttenuation），聚光再乘角度衰减（GetAngularAttenuation）
  // 分了簇时只看这一簇的光
  let clustered = cluster >= 0;
  var localCount = u32(view.locals.x);
  var firstLight = 0u;
  if (clustered) {
    localCount = clusterCounts(cluster).x;
    firstLight = clusters[u32(cluster)];
  }
  // 面光源每个像素只算一次的部分（有面光源时才查表）
  var area: AreaShading;
  if (localCount > 0u) {
    area = areaShading(surface);
  }
  // 局部光的阴影来自光追时（不透明阶段）：所有局部光的和乘这个像素的可见比例（RayTracedLocalLights）
  let localVisibility = select(1.0, screenLocalVisibility(in.position), view.decal.z > 0.5 && !TRANSPARENT_STAGE);
  for (var k = 0u; k < localCount; k++) {
    let lit = localLightLit(localLight(select(k, clusters[firstLight + k], clustered)), surface, area, in.world, n, directOcclusion);
    direct.diffuse += lit.diffuse * localVisibility;
    direct.specular += lit.specular * localVisibility;
  }
  // 直射光的总和乘 π（MaterialSurfaceLightingAndShading："*PI over hemisphere"），光源强度因此和 Stride 的场景一致。
  // scattered 是所有漫反射光（次表面散射模糊的就是它），镜面反射和自发光另加
  var scattered = direct.diffuse * PI;

  // 环境光和天空盒光都没有的场景（只有直射光）整段跳过
  let hasAmbient = any(view.ambientColor.rgb > vec3f(0.0));
  let hasSky = view.sky.x > 0.0;
  // 环境光：镜面项都乘 DFG（Stride 的环境 BRDF 查找表）；屏幕空间反射合成时要这个权重和加进去的环境镜面反射
  var environmentSpecular = vec3f(0.0);
  var environment = vec3f(0.0);
  if (hasSpecular) {
    let dfg = dfgLookup(vec2f(1.0 - sqrt(alphaR), nDotV));
    let layerSpecular = select(specular * dfg.x + dfg.y, environmentDfgPolynomial(specular, alphaR, nDotV), (microfacet & 64u) != 0u);
    // 光泽：底下那层乘剩下的比例，加上光泽自己的（环境光的方向、粗糙度按底下那层的取，Filament 另按光泽粗糙度取一次）
    environmentSpecular = select(layerSpecular * sheenScaling + sheenColor * sheenDfg, glass.reflectance, isGlass);
  }
  // 反射探针盖住的地方用它的镜面反射，盖不住的部分（1 - a）才用环境光和天空盒的
  var probe = vec4f(0.0);
  if (hasSpecular && view.locals.w > 0.0) {
    probe = probeSpecular(in.world, reflection, sqrt(alphaR), cluster);
  }
  // 平面反射盖在探针上面：盒子里朝着平面法线的表面用镜像着画的场景（probe 是预乘过权重的）
  if (hasSpecular && view.planar.x > 0.0 && !TRANSPARENT_STAGE) {
    let planar = planarSpecular(in.world, in.position.xy, n, sqrt(alphaR));
    probe = vec4f(planar.rgb * planar.a + probe.rgb * (1.0 - planar.a), planar.a + probe.a * (1.0 - planar.a));
  }
  if (probe.a > 0.0) {
    environment = environmentSpecular * probe.rgb * ao;
  }
  // 辐照度体盖住的地方漫反射的环境光用探针的（有遮挡、有反弹），盖不住的部分（1 - a）才用环境光和天空盒的
  let volume = volumeIrradiance(in.world, n, v);
  scattered += diffuse * celEnvironment(volume.rgb) * ao * volume.a;
  if (hasAmbient || hasSky) {
    scattered += diffuse * celEnvironment(view.ambientColor.rgb) * ao * (1.0 - volume.a);
    environment += environmentSpecular * view.ambientColor.rgb * ao * (1.0 - probe.a);
    if (hasSky) {
      let skyIntensity = view.sky.x * ao;
      scattered += diffuse * celEnvironment(evaluateSH(skyDirection(n)) * view.sky.x) * ao * (1.0 - volume.a);
      if (hasSpecular && probe.a < 1.0) {
        environment += environmentSpecular * textureSampleLevel(skySpecular, linearClamp, skyDirection(reflection), sqrt(alphaR) * view.sky.y).rgb * skyIntensity * (1.0 - probe.a);
      }
    }
  }
  // 漫透射的环境光：背面朝着的天空和环境光
  if (thinFactor > 0.0) {
    scattered += backDiffuse * (select(vec3f(0.0), view.ambientColor.rgb, hasAmbient) + select(vec3f(0.0), evaluateSH(skyDirection(-n)) * view.sky.x, hasSky)) * ao;
  }
  // 屏幕空间的间接光（近处表面反射过来的漫反射光；材质自己的遮蔽照样乘）
  scattered += diffuse * screen.xyz * occlusion.x;

  // 自发光：a 不小于 0 时输出的 alpha 用它（Stride 的 UseAlpha）
  let emitted = emissiveColor(in);
  // 限在 float16 的上限以内：很光滑的表面（湿的地面）对着太阳的高光能超过 65504，变成无穷大，泛光把它摊成整帧的 NaN
  // 透射：后面折射过来的光，乘没被表面反射走的部分（1 - 环境镜面的比例）、基础色（金属不透光）、比例。它已经含着背景，
  // 输出不透明（alpha 1，透明阶段的预乘混合就是覆盖）
  // 这个视图没有折射拷的画面时（上限 16 张贴图的设备、渲染目标贴图的相机、探针的面）退回普通的透明混合：不偏开、不糊，
  // 背景按透过的比例留下（alpha 是不透过的那部分）
  var transmitted = vec3f(0.0);
  var alpha = select(base.a, emitted.a, emitted.a >= 0.0);
  if (transmission > 0.0) {
    let tint = select(albedo, albedo * (1.0 - metalness), isMetalness);
    let passes = saturate(1.0 - environmentSpecular) * tint * transmission;
    if (view.decal.y > 0.0) {
      transmitted = transmittedLight(in.world, n, v, roughness, cluster) * passes;
      alpha = 1.0;
    } else {
      alpha = 1.0 - dot(passes, vec3f(1.0 / 3.0));
    }
  }
  // 室内映射：玻璃后面的房间，乘没被反射走的部分
  let interior = interiorLight(in.world, n) * saturate(1.0 - max(environmentSpecular.r, max(environmentSpecular.g, environmentSpecular.b)));
  // 和 Stride 不同：透明阶段里混合的材质，颜色也乘基础色（贴图）的 alpha，才是真正的预乘。Stride 只拿它管遮挡（后面的东西
  // 减多少），贴图透明的地方照样加上整块的光，得自己把贴图预乘（玻璃上的手印、水雾这种贴图大半透明的就整片发白）
  let coverage = select(1.0, base.a, TRANSPARENT_STAGE && transmission <= 0.0);
  let color = min(scattered + direct.specular * PI + environment + transmitted + interior + layerEmissive(in, emitted.rgb), vec3f(60000.0)) * coverage;
  // 预乘 alpha：颜色已经乘过 alpha；不透明的阶段不混合，alpha 不起作用。网格效果最后可以改颜色（Stride 的 ShadingBase.Shading）
  return Shaded(effectShading(vec4f(color, saturate(alpha * material.blend.a)), in.effect), n, roughness, environmentSpecular, environment, scattered);
}`;
