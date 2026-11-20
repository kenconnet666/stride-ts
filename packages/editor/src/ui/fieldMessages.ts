/**
 * 组件、场景设置、字段的名字和说明的翻译（见 i18n.ts）。字段描述（引擎的 editor/fields.ts）是英语的，按 gettext 的做法拿英语原文
 * 当键：组件和设置的标题、字段的说明按原文找译文，字段名按标识符找；没有译文的显示原文（英语界面就是原文）。字段的描述加了
 * 新的标题、说明时这里没跟上，界面照常显示英语，补上就好。
 * 字段对象在组件之间共用（阴影、碰撞形状），所以不按路径翻。枚举的值是文件里的值，不翻。
 */
import type { Field } from '@stride-ts/engine/editor-fields';
import type { MessageTable } from '@zerodep-dev/vue-tsx-pro-ui';
import { translations } from './i18n';

export interface FieldMessages {
  /** 组件、场景设置、资源的标题：英语原文 → 译文。 */
  readonly labels: Readonly<Record<string, string>>;
  /** 字段名（标识符）→ 显示的名字。 */
  readonly names: Readonly<Record<string, string>>;
  /** 字段的说明：英语原文 → 译文。 */
  readonly descriptions: Readonly<Record<string, string>>;
}

const zhCN: FieldMessages = {
  labels: {
    'Model': '模型', 'Camera': '相机', 'Light': '光源', 'Background': '背景', 'Reflection probe': '反射探针', 'Sky atmosphere': '物理天空',
    'Volumetric clouds': '体积云', 'Volumetric fog': '体积雾', 'Day-night cycle': '日夜循环', 'Wind zone': '风区', 'Precipitation': '雨雪',
    'Decal': '贴花', 'Weather': '天气', 'Sprite': '精灵', 'Animation': '动画', 'Static collider': '静态碰撞体', 'Body': '刚体', 'Character': '角色',
    'Constraints': '约束', 'Particle system': '粒子系统', 'UI': 'UI', 'Instancing': '实例化', 'Instance': '实例', 'Model node link': '跟随模型节点',
    'UI element link': '跟随 UI 元素', 'Physics': '物理', 'Navigation': '导航', 'Offset': '偏移', 'Compositor': '合成器', 'Material': '材质', 'Timeline': '时间轴', 'Camera rig': '镜头系统',
  },
  names: {
    addressU: 'U 方向寻址', addressV: 'V 方向寻址', aerialPerspectiveScale: '空气透视的距离倍数', agentHeight: '代理的高度', agentMaxClimb: '代理能迈的高度',
    agentMaxSlopeDegrees: '代理能走的坡度', agentRadius: '代理的半径', airControlForceScale: '空中操控力的比例', airControlScale: '空中速度的比例', albedo: '反照率',
    albedoMix: '颜色的比例', alphaCutoff: '透明裁剪阈值', ambient: '环境光', ambientOcclusion: '环境光遮蔽', angleInner: '内锥角', angleOuter: '外锥角',
    angularDamping: '角阻尼', animations: '动画剪辑', anisotropy: '各向异性', antialiasing: '抗锯齿', atmosphereHeight: '大气层厚度', backFace: '背面',
    baseColor: '基础色', baseColorOperator: '基础色的混合', baseColorTexture: '基础色贴图', baseHeight: '基准高度', blendCascades: '级联之间过渡',
    blendDistance: '过渡距离', blendMode: '混合模式', blend: '过渡', brushes: '笔刷', points: '顶点', topRadius: '顶面半径', segments: '分段', operation: '运算', material: '材质槽', octaves: '层数', seed: '种子', randomness: '随机程度', columns: '列数', rows: '行数', mortar: '灰缝', shift: '错开', angle: '角度', softness: '柔和', repeat: '重复', inMin: '输入下限', inMax: '输入上限', gamma: '伽马', outMin: '输出下限', outMax: '输出上限', exponent: '指数', from: '起点颜色', to: '终点颜色', graph: '节点图', spawnCount: '数量', loopCondition: '循环', delay: '延迟', framerate: '帧率', randomSize: '大小范围', positionMin: '位置下限', positionMax: '位置上限', velocityMin: '速度下限', velocityMax: '速度上限', directionMin: '方向下限', directionMax: '方向上限', angularRotation: '角度范围', colorMin: '颜色下限', colorMax: '颜色上限', seedOffset: '随机偏移', gravitationalAcceleration: '重力加速度', forceDirected: '定向力', forceVortex: '涡旋力', forceRepulsive: '排斥力', forceFixed: '恒定力', energyConservation: '能量守恒', killParticles: '碰到就消失', isHollow: '空心', drag: '拖曳', terminalVelocity: '终端速度', surface: '表面', emitterName: '名字', particleLifetime: '寿命', maxParticlesOverride: '最多粒子数', simulationSpace: '模拟空间', sortingPolicy: '排序', drawPriority: '绘制优先级', simulation: '模拟', computeColor: '颜色树', uvBuilder: 'UV', alphaAdditive: '加色程度', bloom: '泛光', bodyA: '物体 A', bodyB: '物体 B', bottom: '底部高度', boxProjection: '盒投影',
    brightFilter: '亮部提取', build: '生成设置', camera: '相机', cascadeCount: '级联数', cavity: '缝隙遮蔽', celShading: '卡通着色', cellHeight: '体素高度',
    cellSize: '体素大小', center: '中心', centerFromMiddle: '从中间算中心', clearCoat: '清漆层', clearColor: '清屏色', clip: '剪辑', cloudCoverage: '云量',
    cloudType: '云的类型', collisionMasks: '碰撞遮罩', color: '颜色', coverage: '覆盖率', dayLength: '一天的长度', dayOfYear: '一年中的第几天', density: '密度',
    depthBias: '深度偏移', depthRange: '深度范围', detailSampleDistance: '细节采样距离', detailSampleMaxError: '细节采样误差', diffuse: '漫反射',
    diffuseShading: '漫反射着色', displacementTree: '位移', distance: '距离', doubleSided: '双面', dropPostponedTicks: '丢掉积压的步', edgeFade: '边缘淡出',
    emissive: '自发光', emissiveTexture: '自发光贴图', emissiveTree: '自发光（颜色树）', enabled: '开启', encoding: '编码', farClipPlane: '远裁剪面',
    farFog: '远处的高度雾', filter: '过滤', fixedTimeStep: '固定步长', fog: '雾', format: '格式版本', frame: '帧', friction: '摩擦系数', glass: '玻璃',
    glossinessTexture: '光泽度贴图', gravity: '重力', groundAlbedo: '地面反照率', gustiness: '阵风', height: '高度', heightFalloff: '高度衰减', hull: '凸包',
    ignoreDepth: '不比深度', image: '图片', includedLayers: '包含的层', intensity: '强度', interpolated: '插值', invertY: 'Y 取反', isAlphaCutoff: '透明裁剪',
    isBillboard: '朝向相机', isFixedSize: '固定大小', isFullScreen: '全屏', isShadowCaster: '投阴影', isTransparent: '透明', jumpForce: '起跳速度',
    kind: '种类', kinematic: '运动学', latitude: '纬度', layer: '碰撞层', layers: '层', length: '长度', lensFlare: '镜头光晕', lightAngle: '光源角直径',
    lightStreak: '光芒', linearDamping: '线阻尼', localOffset: '本地偏移', localReflections: '屏幕空间反射', lowerFade: '下端淡出', mass: '质量', master: '主',
    materials: '材质', maxDistance: '最远距离', maxEdgeLength: '最长边', maxRoughness: '最大粗糙度', maxSimplificationError: '简化误差',
    maximumHorizontalForce: '最大水平力', maximumTimeToProcess: '每帧最长处理时间', maximumVerticalForce: '最大竖直力', mergeRegionSize: '合并区域大小',
    meshEffect: '网格效果', metalness: '金属度', microfacet: '微表面模型', mieAbsorption: '米氏吸收', miePhaseG: '米氏相函数的 g', mieScattering: '米氏散射',
    minDistance: '最近距离', minRegionSize: '最小区域', mode: '模式', model: '模型', moon: '月亮', moonDiskIntensity: '月面亮度', moonPhase: '月相', name: '名字',
    nearClipPlane: '近裁剪面', nodeName: '节点名', noise: '噪声', noiseScale: '噪声尺度', normal: '法线贴图', normalFade: '法线淡出', normalMap: '法线贴图',
    normalOffsetScale: '法线偏移', normalTree: '法线（颜色树）', north: '北方', offset: '偏移', opacity: '不透明度', orthographicSize: '正交大小',
    ozoneAbsorption: '臭氧吸收', page: '页面', particlesOverUI: '粒子画在 UI 上面', pixelsPerUnit: '每单位像素', planetRadius: '行星半径', position: '位置',
    postEffects: '后处理', precipitation: '降水', premultipliedAlpha: '预乘 alpha', procedural: '形状', projection: '投影', pssmFactor: '级联分割系数',
    pulseFrequency: '脉动频率', pulseMagnitude: '脉动幅度', radius: '半径', range: '范围', rayleighScattering: '瑞利散射', refractiveIndex: '折射率',
    refresh: '刷新', renderGroup: '渲染组', renderMask: '渲染掩码', resolution: '分辨率', resolutionStretch: '分辨率适配', rotation: '旋转', roughness: '粗糙度',
    sampler: '采样器', scale: '缩放', settings: '设置', shadow: '阴影', shadows: '阴影', shapes: '形状', sheen: '光泽', sheet: '图集', size: '大小',
    skyIntensity: '天空亮度', skybox: '天空盒', sleepThreshold: '睡眠阈值', slopeAngle: '能站的坡度', slot: '槽', snapText: '文字对齐像素', specular: '镜面',
    specularEnergyConservative: '镜面能量守恒', specularShading: '镜面着色', speed: '速度', srgb: 'sRGB', stabilization: '稳定', starsIntensity: '星星亮度',
    strength: '强度', subsurfaceScattering: '次表面散射', sun: '太阳', target: '目标', temperature: '温度', tessellation: '细分', texture: '贴图',
    textureCameras: '画进贴图的相机', thickness: '厚度', tileSize: '分块大小', timeOfDay: '时刻', toneMap: '色调映射', transitionTime: '过渡时间',
    transparency: '透明', transparent: '画透明物体', trigger: '触发器', turbulence: '湍流', type: '类型', upperFade: '上端淡出', uvScale: 'UV 缩放',
    verticalFieldOfView: '竖直视角', windDirection: '风向', windSpeed: '风速',
    duration: '时长', frameRate: '帧率', tracks: '轨道', entity: '实体', component: '组件', property: '属性', interpolation: '插值', keys: '关键帧',
    time: '时刻', value: '值', in: '入切线', out: '出切线',
    physical: '物理相机', aspectRatio: '画幅', follow: '跟随', followDamping: '跟随的平滑', lookAt: '注视', lookOffset: '注视的偏移', lookDamping: '注视的平滑',
    shakeRotation: '晃动的角度', shakePosition: '晃动的位移', shakeFrequency: '晃动的频率', sensor: '传感器', focalLength: '焦距', aperture: '光圈', focusDistance: '对焦距离', shutterAngle: '快门角', exposureCompensation: '曝光补偿', depthOfField: '景深', cuts: '切点', clips: '片段', start: '开始', sound: '声音', volume: '音量', cues: '字幕条', end: '结束', text: '文字', events: '事件',
  },
  descriptions: {
    "one per material slot of the model; null keeps the model's own material; omitted keeps all of them": '模型的每个材质槽一个；null 用模型自带的材质；不写时全用模型自带的',
    'entity with the directional light of the sun; unset uses the shadow-casting directional light': '太阳那盏方向光所在的实体；不设时用投阴影的方向光',
    'entity with the directional light of the moon (its color and intensity are those of the full moon)': '月亮那盏方向光所在的实体（它的颜色和强度是满月的）',
    '0 stratus, 0.5 stratocumulus, 1 cumulus': '0 层云，0.5 层积云，1 积云',
    'where the wind blows to, around Y: 0 is +Z, 90 is +X': '风吹向哪里，绕 Y 轴：0 是 +Z，90 是 +X',
    'extinction per meter at the base height': '基准高度上每米的消光',
    'clumps that drift with the wind': '跟着风飘的团块',
    'analytic height fog beyond distance': '距离以外用解析的高度雾',
    'game seconds per day; 0 keeps the time still': '一天是多少游戏秒；0 时时间不走',
    '0 new moon, 0.5 full moon': '0 新月，0.5 满月',
    "directional blows everywhere along the entity's -Z; spherical blows outward within the radius": 'directional 处处沿实体的 -Z 吹；spherical 在半径内往外吹',
    'gusts swing the strength by 1 ± this': '阵风让强度在 1 ± 这个数之间摆',
    'set by the weather; 0 stops it': '由天气设；0 停下',
    'half size of the volume around the camera': '相机周围那块体积的一半大小',
    'how far above the camera it starts falling': '从相机上方多高开始落',
    "box size in meters; projects along the entity's -Y": '盒子的大小（米）；沿实体的 -Y 投影',
    'color texture (sRGB); its alpha masks the decal': '颜色贴图（sRGB）；它的 alpha 是贴花的遮罩',
    'tangent-space normal map (green up)': '切线空间的法线贴图（绿色朝上）',
    'how much of the color is replaced; 0 keeps only the normal': '颜色换掉多少；0 只留法线',
    'fade surfaces that face away from the projection': '背向投影方向的表面淡出',
    '0 layered stratus, 1 towering cumulonimbus': '0 成层的层云，1 高耸的积雨云',
    'rain or snow (by temperature); 1 is a downpour': '雨或雪（看温度）；1 是大暴雨',
    'below 1 °C it snows': '低于 1 °C 下雪',
    'how fast the current weather follows; 0 changes at once': '现在的天气跟过去有多快；0 立刻变',
    'a texture file ({ texture, encoding }) or a render texture ({ renderTexture, width, height, hdr, srgb })': '贴图文件（{ texture, encoding }）或渲染目标贴图（{ renderTexture, width, height, hdr, srgb }）',
    'null links to the parent entity': 'null 跟随父实体',
    'linear base color; multiplied with (or added to) the texture': '线性空间的基础色；和贴图相乘（或相加）',
    'metalness workflow; leave unset for the specular workflow': '金属度工作流；用镜面工作流时不设',
    'specular workflow (instead of metalness)': '镜面工作流（代替金属度）',
    'linear color times intensity (can exceed 1 for bloom)': '线性颜色乘强度（可以超过 1，泛光用）',
    'pixels with a base color alpha below it are discarded': '基础色的 alpha 低于它的像素丢掉',
    'file format version': '文件格式的版本',
    'material per slot (a procedural model has one slot)': '每个槽的材质（基本形状的模型只有一个槽）',
    'frames per second for snapping and display in the editor': '编辑器里吸附和显示用的每秒帧数',
    'id of the entity in the scene file': '场景文件里的实体 id',
    'runtime component name (Transform, Light, or a game component registered by module path)': '运行时的组件名（Transform、Light，或者游戏按模块路径登记的组件）',
    'a number, or the components (xyz, xyzw, rgba)': '一个数，或者按分量（xyz、xyzw、rgba）',
    'cubic only: slope (per second) arriving at the key, per component; unset is automatic': '只用于 cubic：进关键帧时每秒变多少，按分量；不写是自动的',
    'cubic only: slope (per second) leaving the key, per component; unset is automatic': '只用于 cubic：出关键帧时每秒变多少，按分量；不写是自动的',
    'id of the camera entity in the scene file': '场景文件里相机实体的 id',
    'sensor width and height; 36x24 is full frame': '传感器的宽、高；36x24 是全画幅',
    'replaces verticalFieldOfView': '代替竖直视角',
    'entity to follow; unset keeps the position': '跟着走的实体；不设时位置不动',
    'half-life of the smoothing; 0 snaps': '平滑的半衰期；0 是直接到',
    'entity to look at; unset keeps the rotation': '看着的实体；不设时朝向不动',
    'handheld shake': '手持晃动',
    'frame width / height (2.39, 1.778, 0.5625); bars outside it; 0 fills the canvas': '画幅的宽 / 高（2.39、1.778、0.5625），以外画黑边；0 是整个画布',
    'f-number; smaller is a shallower depth of field': 'f 值；越小景深越浅',
    'motion blur: 180 exposes half a frame': '运动模糊：180 是曝光半帧',
    'blur by aperture, focal length and focus distance (needs post effects)': '按光圈、焦距、对焦距离模糊（要开后处理）',
    'physical camera: focal length, aperture, focus, shutter, exposure (main view only)': '物理相机：焦距、光圈、对焦、快门、曝光（只对主画面）',
    'seconds of crossfade from the previous clip': '从前一个片段过渡过来的秒数（交叉淡化）',
    'material slots; a brush picks one by index': '材质槽；笔刷按下标选一个',
    'automatic UVs: one texture repeat per this many meters': '自动 UV：多少米重复一次贴图',
    'polygon in the XZ plane as [x, z] pairs (may be concave), extruded up from the position': 'XZ 平面上的多边形，[x, z] 一对一个点（可以是凹的），从位置往上挤出',
    'unset: same as radius; 0 makes a cone': '不写时同半径；0 是圆锥',
    'index into materials': '材质槽的下标',
    'a texture asset (an imported image)': '贴图资源（导入的图片）',
    'material node graph (edited in the node graph panel); its outputs override the values above': '材质节点图（在节点图面板里编辑），它的输出盖过上面的值',
    'name of the clip in the AnimationComponent': 'AnimationComponent 里剪辑的名字',
  },
};

const enUS: FieldMessages = { labels: {}, names: {}, descriptions: {} };

export const fieldMessages: MessageTable<FieldMessages> = { 'zh-CN': zhCN, 'en-US': enUS };

const text = translations(fieldMessages);

/** 组件、场景设置、资源的标题。 */
export function labelText(label: string): string {
  return text.labels[label] ?? label;
}

/** 字段显示的名字：有 label 的翻 label，没有的翻字段名；都没有译文时是原文。 */
export function fieldName(field: Field): string {
  return field.label !== undefined ? labelText(field.label) : text.names[field.name] ?? field.name;
}

/** 字段的说明（鼠标停在名字上看）；没有说明时是字段名。 */
export function fieldDescription(field: Field): string {
  const description = field.description === undefined ? undefined : text.descriptions[field.description] ?? field.description;
  const name = fieldName(field);
  // 名字翻过了的，说明里带上原来的标识符（文件里、脚本里写的是它）
  const identifier = name === field.name ? '' : field.name;
  return [description, identifier].filter(Boolean).join(' · ') || field.name;
}
