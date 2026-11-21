/**
 * 编辑器界面的文案（见 i18n.ts）：简体中文和英语各一份。要填参数的写成函数；字段和组件的名字、说明在 fieldMessages.ts。
 * 后端、引擎抛出来的报错是英语（运行时的报错不翻，同项目约定），原样显示。
 */
import type { MessageTable } from '@zerodep-dev/vue-tsx-pro-ui';
import type { NewAssetOption, ProceduralShapeType } from '../newAssets';
import { translations } from './i18n';

export interface EditorMessages {
  // 工具条
  readonly save: string;
  readonly undo: string;
  readonly redo: string;
  readonly addEntity: string;
  readonly deleteSelection: string;
  readonly copySelection: string;
  readonly paste: string;
  readonly duplicate: string;
  readonly makePrefab: string;
  readonly play: string;
  readonly stopPlaying: string;
  readonly snap: string;
  readonly snapOn: string;
  readonly snapOff: string;
  readonly snapSurfaceOn: string;
  readonly snapSurfaceOff: string;
  readonly snapStep: { readonly [K in 'translate' | 'rotate' | 'scale']: { readonly label: string; readonly title: string } };
  readonly prefabTitle: (path: string) => string;
  readonly mainToolbar: string;
  readonly viewportToolbar: string;
  readonly openDocuments: string;
  readonly selectedCount: (n: number) => string;
  readonly toolWindows: { readonly scene: string; readonly assets: string; readonly inspector: string; readonly timeline: string; readonly graph: string; readonly particles: string };
  readonly language: string;
  readonly frameGuide: string;
  readonly frameGuideOff: string;
  readonly actionSafe: string;
  readonly titleSafe: string;
  // 视口
  readonly openingGame: string;
  readonly gameViewport: string;
  // 场景树
  readonly sceneEntities: string;
  readonly documentNode: string;
  // 资源浏览器
  readonly assets: string;
  readonly pathPlaceholder: string;
  readonly moveRename: string;
  readonly delete: string;
  readonly open: string;
  readonly newAsset: string;
  readonly newAssetLabels: { readonly scene: string; readonly material: string; readonly ui: string; readonly timeline: string; readonly brush: string; readonly sdf: string; readonly poly: string; readonly shape: (shape: string) => string };
  readonly shapes: Readonly<Record<ProceduralShapeType, string>>;
  readonly importing: string;
  readonly working: (action: string) => string;
  readonly moved: (assets: number, rewritten: number) => string;
  readonly deleteAnyway: (error: string) => string;
  readonly notDeleted: string;
  readonly deleted: (kind: string, path: string) => string;
  readonly opened: (kind: string, path: string) => string;
  readonly created: (kind: string, path: string) => string;
  readonly imported: (assets: readonly string[]) => string;
  // 属性面板
  readonly assetLabels: { readonly material: string; readonly model: string; readonly timeline: string; readonly brush: string; readonly sdf: string; readonly poly: string; readonly gameSettings: string };
  readonly assetHint: (kind: string, path: string) => string;
  readonly instanceOf: (prefab: string) => string;
  readonly memberOf: (prefab: string, instance: string, member: string) => string;
  readonly instanceChanges: (own: number, removed: number) => string;
  readonly parentMissing: (parent: string) => string;
  readonly scriptNeedsComponents: (script: string, components: readonly string[]) => string;
  readonly removedRequired: (component: string, dependents: readonly string[]) => string;
  readonly sceneSettingsHint: (scene: string) => string;
  readonly remove: (what: string) => string;
  readonly addSetting: string;
  readonly addSettingMenu: string;
  readonly sceneNotOpen: string;
  readonly noScene: string;
  readonly childSceneHint: (path: string) => string;
  readonly showChildScene: (name: string) => string;
  readonly hideChildScene: (name: string) => string;
  readonly noSceneNoSettings: string;
  readonly pickEntity: string;
  readonly multiSelection: (count: number) => string;
  readonly removeScript: string;
  readonly addComponent: string;
  readonly addComponentMenu: string;
  readonly scripts: string;
  // 字段
  readonly mixed: string;
  readonly eulerHint: string;
  readonly none: string;
  // 时间轴面板
  readonly timelinePlay: string;
  readonly timelinePause: string;
  readonly timelineThroughCamera: string;
  readonly timelineAddKey: string;
  readonly timelineKeyTransform: string;
  readonly timelineDeleteKey: string;
  readonly timelineClose: string;
  readonly timelineTracks: { readonly camera: string; readonly animation: string; readonly sound: string; readonly subtitle: string; readonly event: string };
  readonly timelineNoValue: (component: string, property: string) => string;
  readonly timelineCurves: string;
  readonly timelineInterpolation: string;
  readonly timelineInterpolations: { readonly constant: string; readonly linear: string; readonly cubic: string };
  readonly timelineAutoTangent: string;
  readonly timelineFlatTangent: string;
  readonly timelineExport: string;
  readonly timelineExporting: string;
  readonly timelineExportPresets: { readonly landscape1080: string; readonly vertical1080: string; readonly square1080: string };
  readonly timelineExported: (path: string, seconds: number) => string;
  readonly graphOpen: string;
  readonly paintLayers: string;
  readonly particleOpen: string;
  // 多边形编辑
  readonly polyEdit: string;
  readonly realtimeOn: string;
  readonly realtimeOff: string;
  readonly polyDone: string;
  readonly polyHint: string;
  readonly polyModes: Readonly<Record<'vertex' | 'edge' | 'face', string>>;
  readonly polyAmount: string;
  readonly polyOps: Readonly<Record<'extrude' | 'inset' | 'bevel' | 'merge' | 'split' | 'connect' | 'delete' | 'flip', string>>;
  readonly polyConnectNeedsFace: string;
  readonly particleEmitters: string;
  readonly particleBake: string;
  readonly particleBaking: string;
  readonly particleBakeHint: (frames: number) => string;
  readonly particleBaked: (path: string, frames: number, seconds: number) => string;
  readonly particleBakeFields: { readonly columns: string; readonly rows: string; readonly size: string; readonly seconds: string; readonly start: string; readonly view: string };
  readonly particleBakeViews: { readonly front: string; readonly side: string; readonly top: string };
  readonly particleEmitter: (n: number) => string;
  readonly particleAddEmitter: string;
  readonly particleRemoveEmitter: string;
  readonly particleClose: string;
  readonly particleNoSystem: string;
  readonly particleEmitterSettings: string;
  readonly particleAddModule: string;
  readonly particleUp: string;
  readonly particleDown: string;
  readonly particleRemove: string;
  readonly particleAddCurve: string;
  readonly particleRemoveCurve: string;
  readonly particleStacks: { readonly spawners: string; readonly initializers: string; readonly updaters: string; readonly shapeBuilder: string; readonly material: string };
  readonly particleModules: Readonly<Record<string, string>>;
  readonly particleFields: Readonly<Record<string, string>>;
  readonly paintAddLayer: string;
  readonly paintLayer: (n: number) => string;
  readonly paintColor: string;
  readonly paintRoughness: string;
  readonly paintMetalness: string;
  readonly paintStart: string;
  readonly paintStop: string;
  readonly paintRadius: string;
  readonly paintHardness: string;
  readonly paintStrength: string;
  readonly paintErase: string;
  readonly paintHint: string;
  readonly paintSelectEntity: string;
  readonly paintNoMask: string;
  readonly clipboardNotEntities: string;
  readonly graphAddNode: string;
  readonly graphHint: string;
  readonly graphClose: string;
  readonly graphNoMaterial: string;
  readonly graphOutput: string;
  readonly graphOutputs: { readonly baseColor: string; readonly metalness: string; readonly roughness: string; readonly normal: string; readonly emissive: string; readonly occlusion: string };
  readonly graphCategories: Readonly<Record<string, string>>;
  readonly graphNodes: Readonly<Record<string, string>>;
  readonly graphPorts: Readonly<Record<string, string>>;
  // 会话
  readonly prefabMade: (path: string) => string;
  readonly savedWithMissing: (count: number, first: readonly string[], more: boolean) => string;
}

const zhCN: EditorMessages = {
  save: '保存（Ctrl+S）',
  undo: '撤销（Ctrl+Z）',
  redo: '重做（Ctrl+Y）',
  addEntity: '加实体（选中的实体下面）',
  deleteSelection: '删掉选中的实体（Delete）',
  copySelection: '复制选中的实体（Ctrl+C）',
  paste: '粘贴到选中的实体后面（Ctrl+V；Ctrl+Shift+V 粘贴成它的子实体）',
  duplicate: '复制一份（Ctrl+D）',
  makePrefab: '做成预制体（选中的一个实体连同后代，场景里换成它的实例）',
  play: '试玩',
  stopPlaying: '停止试玩',
  snap: '吸附',
  snapOn: '吸附开着（拖的时候按住 Ctrl 临时不吸）',
  snapOff: '吸附关着（拖的时候按住 Ctrl 临时吸附）',
  snapSurfaceOn: '吸附到表面开着：拖移动的操纵器时东西落到光标下的表面上（底面贴着它）',
  snapSurfaceOff: '吸附到表面关着：点一下打开，拖移动的操纵器时东西落到光标下的表面上',
  snapStep: {
    translate: { label: '移动', title: '移动的步长（米）' },
    rotate: { label: '旋转', title: '旋转的步长（度）' },
    scale: { label: '缩放', title: '缩放的步长（倍数）' },
  },
  prefabTitle: (path) => `预制体 ${path}`,
  mainToolbar: '主工具条',
  viewportToolbar: '视口工具条',
  openDocuments: '打开的文档',
  selectedCount: (n) => `选中 ${n} 个`,
  toolWindows: { scene: '场景', assets: '资源', inspector: '属性', timeline: '时间轴', graph: '节点图', particles: '粒子' },
  language: '界面语言',
  frameGuide: '画幅参考线（视口上框出画幅和安全框，构图用）',
  frameGuideOff: '画幅：关',
  actionSafe: '动作安全框（93%）',
  titleSafe: '字幕安全框（90%）',
  openingGame: '正在打开游戏……',
  gameViewport: '游戏视口',
  sceneEntities: '场景里的实体',
  documentNode: '场景本身：选中看场景的设置；实体拖到这里挂到根上',
  assets: '资源',
  pathPlaceholder: '新的内容路径',
  moveRename: '移动 / 改名',
  delete: '删除',
  open: '打开',
  newAsset: '新建资源',
  newAssetLabels: { scene: '场景', material: '材质', ui: 'UI 页面', timeline: '时间轴', brush: '白盒（布尔建模）', sdf: 'SDF 模型（平滑融合）', poly: '多边形网格（点线面编辑）', shape: (shape) => `基本形状：${shape}` },
  shapes: { cube: '立方体', plane: '平面', sphere: '球', geoSphere: '测地球', capsule: '胶囊', cylinder: '圆柱', torus: '圆环', cone: '圆锥', teapot: '茶壶' },
  importing: '导入',
  working: (action) => `${action}……`,
  moved: (assets, rewritten) => `挪了 ${assets} 个资源，改写了 ${rewritten} 个引用它们的文件`,
  deleteAnyway: (error) => `${error}\n\n仍然删除？引用它的地方会断掉。`,
  notDeleted: '没有删除',
  deleted: (kind, path) => `删掉了 ${kind} ${path}`,
  opened: (kind, path) => `打开了 ${kind} ${path}`,
  created: (kind, path) => `建了 ${kind} ${path}（路径框里可以改名）`,
  imported: (assets) => `导入了 ${assets.join('、')}`,
  assetLabels: { material: '材质', model: '模型', timeline: '时间轴', brush: '白盒', sdf: 'SDF 模型', poly: '多边形网格', gameSettings: '游戏设置' },
  assetHint: (kind, path) => `${kind} ${path}：改了马上存进资源文件，视口里用到它的实体跟着变。`,
  instanceOf: (prefab) => `预制体 ${prefab} 的实例`,
  memberOf: (prefab, instance, member) => `预制体 ${prefab} 的实例 ${instance} 里的 ${member}`,
  parentMissing: (parent) => `挂着的 ${parent} 不在了（预制体删了这个成员？），先放在最近的实例下面；拖到要放的地方`,
  instanceChanges: (own, removed) => `${own > 0 ? `，这个实体改了 ${own} 处` : ''}${removed > 0 ? `，去掉了 ${removed} 个实体` : ''}。改的值记在实例上，和预制体一样时不记。`,
  scriptNeedsComponents: (script, components) => `${script} 要实体上有 ${components.join('、')}，场景文件里加不了，试玩时这个脚本不挂`,
  removedRequired: (component, dependents) => `去掉了 ${component}；${dependents.join('、')} 要它，试玩时不起作用`,
  sceneSettingsHint: (scene) => `场景 ${scene} 的设置（在场景树或视口里选实体看实体的）。合成器、偏移改了马上看得见；物理、导航试玩时用上。`,
  remove: (what) => `去掉 ${what}`,
  addSetting: '添加设置',
  addSettingMenu: '添加设置……',
  sceneNotOpen: '场景还没打开',
  childSceneHint: (path) => `子场景 ${path}：点眼睛在视口里一起看（只看不改），双击单独打开它编辑`,
  showChildScene: (name) => `在视口里一起看 ${name}`,
  hideChildScene: (name) => `不再一起看 ${name}`,
  noScene: '这个游戏没有场景：画面是游戏自己的根渲染器画的，属性面板里改游戏设置（根渲染器的属性改了马上看到）',
  noSceneNoSettings: '这个游戏没有场景，也没有用 loadGameSettings 读游戏设置：编辑器没有能改的东西',
  pickEntity: '在场景树或视口里选一个实体（Ctrl、Shift 多选）',
  multiSelection: (count) => `选中了 ${count} 个实体：显示它们都有的组件，值不一样的显示"多个值"；改一处改所有的，一步撤销。`,
  removeScript: '去掉这个脚本',
  addComponent: '添加组件',
  addComponentMenu: '添加组件……',
  scripts: '脚本',
  mixed: '多个值',
  eulerHint: '角度（度），先绕 Z、再绕 X、再绕 Y（同 Stride）',
  none: '（无）',
  timelinePlay: '播放（预览）',
  timelinePause: '暂停',
  timelineThroughCamera: '从时间轴的相机里看（相机轨道那一刻的相机）',
  timelineAddKey: '在播放头给选中的轨道加关键帧（取实体现在的值）',
  timelineKeyTransform: '在播放头给选中的实体的位置、旋转加关键帧（没有轨道就加上）',
  timelineDeleteKey: '删掉选中的关键帧',
  timelineClose: '关掉时间轴（视口回到场景的样子）',
  timelineTracks: { camera: '相机切换', animation: '动画', sound: '声音', subtitle: '字幕', event: '事件' },
  timelineNoValue: (component, property) => `实体上没有 ${component}.${property}，加不了关键帧`,
  timelineCurves: '曲线编辑器（选中的属性轨道按曲线显示：上下拖关键帧改值，拖手柄改切线）',
  timelineInterpolation: '插值',
  timelineInterpolations: { constant: '阶梯', linear: '线性', cubic: '曲线' },
  timelineAutoTangent: '自动切线',
  timelineFlatTangent: '平切线',
  timelineExport: '出片（从头离线渲染成 MP4，带声音，存进工程的 exports 文件夹）',
  timelineExporting: '出片中…',
  timelineExportPresets: { landscape1080: '横屏 1080p', vertical1080: '竖屏 9:16', square1080: '方形 1:1' },
  timelineExported: (path, seconds) => `已导出 ${path}（${seconds.toFixed(0)} 秒）`,
  graphOpen: '节点图',
  paintLayers: '图层',
  particleOpen: '粒子编辑器',
  polyEdit: '编辑多边形',
  realtimeOn: '视口一直在画（粒子、天气一直动）：点一下改成静止时不画，省显卡',
  realtimeOff: '视口静止时不画（有输入、修改时才画，省显卡）：点一下改成一直画，粒子、天气一直动',
  polyDone: '完成',
  polyHint: '视口里点选点、边、面（1、2、3 换模式，Shift、Ctrl 加选），拖操纵器移动（W、E、R 换移动、旋转、缩放）；Delete 删面，Ctrl+Z 撤销',
  polyModes: { vertex: '点', edge: '边', face: '面' },
  polyAmount: '距离',
  polyOps: { extrude: '挤出', inset: '内插', bevel: '倒角', merge: '合并', split: '切分', connect: '连接', delete: '删面', flip: '翻面' },
  polyConnectNeedsFace: '连接要选同一个面上不相邻的两个点',
  particleEmitters: '发射器',
  particleBake: '烘成序列帧',
  particleBaking: '正在烘……',
  particleBakeHint: (frames) => `${frames} 帧排成一张图集，存进 Textures；旁边加一个放它的实体（一个粒子）`,
  particleBaked: (path, frames, seconds) => `烘好了 ${path}（${frames} 帧，${seconds.toFixed(2)} 秒）`,
  particleBakeFields: { columns: '列', rows: '行', size: '每格像素', seconds: '时长', start: '从第几秒', view: '方向' },
  particleBakeViews: { front: '正面', side: '侧面', top: '顶上' },
  particleEmitter: (n) => `发射器 ${n}`,
  particleAddEmitter: '加发射器',
  particleRemoveEmitter: '删掉这个发射器',
  particleClose: '关掉粒子编辑器',
  particleNoSystem: '选中一个有粒子系统的实体，在属性面板上点"粒子编辑器"',
  particleEmitterSettings: '发射器',
  particleAddModule: '加模块',
  particleUp: '往上挪',
  particleDown: '往下挪',
  particleRemove: '删掉这个模块',
  particleAddCurve: '加曲线',
  particleRemoveCurve: '去掉曲线',
  particleStacks: { spawners: '生成', initializers: '初始化', updaters: '更新', shapeBuilder: '形状', material: '材质' },
  particleModules: {
    spawnerPerSecond: '每秒生成', spawnerBurst: '一次爆发', spawnerPerFrame: '每帧生成', spawnerFromDistance: '按移动距离生成',
    initialSizeSeed: '随机大小', initialPositionSeed: '随机位置', initialVelocitySeed: '随机速度', initialDirectionSeed: '随机方向', initialRotationSeed: '随机旋转',
    initialColorSeed: '随机颜色', initialSpawnOrder: '生成顺序', initialPositionArc: '弧线位置', initial3DRotationSeed: '随机三维旋转',
    updaterGravity: '重力', updaterSizeOverTime: '大小随寿命', updaterColorOverTime: '颜色随寿命', updaterRotationOverTime: '旋转随寿命', updaterSpeedToDirection: '朝向速度',
    updaterWind: '风', updaterForceField: '力场', updaterCollider: '碰撞', updaterDepthCollision: '按深度碰撞',
    shapeBuilderBillboard: '公告板', shapeBuilderQuad: '方片', shapeBuilderOrientedQuad: '朝速度的方片', shapeBuilderHexagon: '六边形',
    particleMaterialComputeColor: '颜色材质',
  },
  particleFields: { samplerMain: '曲线', samplerOptional: '第二条曲线', samplerSize: '大小曲线', samplerRotation: '旋转曲线' },
  paintAddLayer: '加绘制层',
  paintLayer: (n) => `图层 ${n}`,
  paintColor: '这一层的颜色',
  paintRoughness: '粗糙度',
  paintMetalness: '金属度',
  paintStart: '画',
  paintStop: '停止画',
  paintRadius: '半径',
  paintHardness: '硬度',
  paintStrength: '强度',
  paintErase: '擦除',
  paintHint: '在视口里按住左键在选中的实体上画（Alt、右键照常转相机）；每一笔画完存进遮罩',
  paintSelectEntity: '先在场景里选中要画的实体（它要用这个材质）',
  paintNoMask: '这一层的遮罩不是一张图，画不了（加一个绘制层）',
  clipboardNotEntities: '剪贴板里不是复制的实体',
  graphAddNode: '加节点……',
  graphHint: '拖节点移动，拖空白处平移，滚轮缩放；从输出口拖到输入口连线；选中节点或连线按 Delete 删除',
  graphClose: '关掉节点图',
  graphNoMaterial: '在资源浏览器里选中一个材质，属性面板上点"节点图"',
  graphOutput: '材质输出',
  graphOutputs: { baseColor: '基础色', metalness: '金属度', roughness: '粗糙度', normal: '法线', emissive: '自发光', occlusion: '环境光遮蔽' },
  graphCategories: { input: '输入', generator: '生成器', math: '运算', normal: '法线', mapping: '映射' },
  graphNodes: {
    uv: 'UV', position: '位置', time: '时间', value: '数', color: '颜色', texture: '贴图', noise: '噪声', voronoi: 'Voronoi', bricks: '砖块', checker: '棋盘格',
    gradient: '渐变', circle: '圆', add: '加', subtract: '减', multiply: '乘', mix: '混合', invert: '反相', levels: '色阶', power: '幂', colorRamp: '颜色渐变',
    normalFromHeight: '从高度算法线', uvTransform: 'UV 变换',
  },
  graphPorts: { uv: 'UV', position: '位置', time: '时间', value: '值', color: '颜色', distance: '距离', cell: '格子', mask: '遮罩', brick: '每块砖', out: '结果', a: 'A', b: 'B', t: '比例', in: '输入', height: '高度', normal: '法线' },
  prefabMade: (path) => `做成了预制体 ${path}，场景里换成了它的实例（保存场景以后生效）`,
  savedWithMissing: (count, first, more) => `已保存；${count} 处脚本的必填属性没设，试玩时这些脚本不挂：${first.join('、')}${more ? '……' : ''}`,
};

const enUS: EditorMessages = {
  save: 'Save (Ctrl+S)',
  undo: 'Undo (Ctrl+Z)',
  redo: 'Redo (Ctrl+Y)',
  addEntity: 'Add an entity (under the selected one)',
  deleteSelection: 'Delete the selected entities (Delete)',
  copySelection: 'Copy the selected entities (Ctrl+C)',
  paste: 'Paste after the selected entity (Ctrl+V; Ctrl+Shift+V pastes as its children)',
  duplicate: 'Duplicate (Ctrl+D)',
  makePrefab: 'Make a prefab (the selected entity and its descendants; the scene gets an instance of it)',
  play: 'Play',
  stopPlaying: 'Stop playing',
  snap: 'Snapping',
  snapOn: 'Snapping is on (hold Ctrl while dragging to move freely)',
  snapOff: 'Snapping is off (hold Ctrl while dragging to snap)',
  snapSurfaceOn: 'Surface snapping is on: dragging the move gizmo drops things onto the surface under the cursor (resting on their bottom)',
  snapSurfaceOff: 'Surface snapping is off: click to drop things onto the surface under the cursor while dragging the move gizmo',
  snapStep: {
    translate: { label: 'Move', title: 'Move step (meters)' },
    rotate: { label: 'Rotate', title: 'Rotation step (degrees)' },
    scale: { label: 'Scale', title: 'Scale step (factor)' },
  },
  prefabTitle: (path) => `Prefab ${path}`,
  mainToolbar: 'Main toolbar',
  viewportToolbar: 'Viewport toolbar',
  openDocuments: 'Open documents',
  selectedCount: (n) => `${n} selected`,
  toolWindows: { scene: 'Scene', assets: 'Assets', inspector: 'Inspector', timeline: 'Timeline', graph: 'Node graph', particles: 'Particles' },
  language: 'Interface language',
  frameGuide: 'Frame guide (the frame and safe areas over the viewport, for composing shots)',
  frameGuideOff: 'Frame: off',
  actionSafe: 'Action safe (93%)',
  titleSafe: 'Title safe (90%)',
  openingGame: 'Opening the game…',
  gameViewport: 'Game viewport',
  sceneEntities: 'Entities in the scene',
  documentNode: 'The scene itself: select it for the scene settings; drop entities here to move them to the root',
  assets: 'Assets',
  pathPlaceholder: 'New content path',
  moveRename: 'Move / rename',
  delete: 'Delete',
  open: 'Open',
  newAsset: 'New asset',
  newAssetLabels: { scene: 'Scene', material: 'Material', ui: 'UI page', timeline: 'Timeline', brush: 'Greybox (CSG)', sdf: 'SDF model (smooth blends)', poly: 'Poly mesh (point, edge, face editing)', shape: (shape) => `Shape: ${shape}` },
  shapes: { cube: 'Cube', plane: 'Plane', sphere: 'Sphere', geoSphere: 'Geosphere', capsule: 'Capsule', cylinder: 'Cylinder', torus: 'Torus', cone: 'Cone', teapot: 'Teapot' },
  importing: 'Import',
  working: (action) => `${action}…`,
  moved: (assets, rewritten) => `Moved ${assets} asset${assets === 1 ? '' : 's'}; rewrote ${rewritten} file${rewritten === 1 ? '' : 's'} that refer to them`,
  deleteAnyway: (error) => `${error}\n\nDelete anyway? The references to it will break.`,
  notDeleted: 'Not deleted',
  deleted: (kind, path) => `Deleted ${kind} ${path}`,
  opened: (kind, path) => `Opened ${kind} ${path}`,
  created: (kind, path) => `Created ${kind} ${path} (rename it in the path box)`,
  imported: (assets) => `Imported ${assets.join(', ')}`,
  assetLabels: { material: 'Material', model: 'Model', timeline: 'Timeline', brush: 'Greybox', sdf: 'SDF model', poly: 'Poly mesh', gameSettings: 'Game settings' },
  assetHint: (kind, path) => `${kind} ${path}: changes are saved to the asset file at once, and the entities that use it in the viewport follow.`,
  instanceOf: (prefab) => `Instance of prefab ${prefab}`,
  memberOf: (prefab, instance, member) => `${member} in ${instance}, an instance of prefab ${prefab}`,
  parentMissing: (parent) => `Its parent ${parent} is gone (removed from the prefab?), so it sits under the nearest instance for now; drag it where it belongs`,
  instanceChanges: (own, removed) => `${own > 0 ? `; ${own} change${own === 1 ? '' : 's'} on this entity` : ''}${removed > 0 ? `; ${removed} entit${removed === 1 ? 'y' : 'ies'} removed` : ''}. Changes are stored on the instance, and values equal to the prefab's are not.`,
  scriptNeedsComponents: (script, components) => `${script} needs ${components.join(', ')} on the entity, which scene files cannot add; the script is not attached when playing`,
  removedRequired: (component, dependents) => `Removed ${component}; ${dependents.join(', ')} need${dependents.length === 1 ? 's' : ''} it and will not work when playing`,
  sceneSettingsHint: (scene) => `Settings of scene ${scene} (select an entity in the scene tree or the viewport to see its own). Compositor and offset changes show at once; physics and navigation apply when playing.`,
  remove: (what) => `Remove ${what}`,
  addSetting: 'Add a setting',
  addSettingMenu: 'Add a setting…',
  sceneNotOpen: 'No scene is open yet',
  childSceneHint: (path) => `Child scene ${path}: click the eye to see it in the viewport (view only), double-click to open it for editing`,
  showChildScene: (name) => `Show ${name} in the viewport`,
  hideChildScene: (name) => `Hide ${name}`,
  noScene: 'This game has no scene: its own root renderer draws the picture. Edit the game settings in the inspector (changes to the renderer show at once)',
  noSceneNoSettings: 'This game has no scene and does not read game settings with loadGameSettings: there is nothing for the editor to edit',
  pickEntity: 'Select an entity in the scene tree or the viewport (Ctrl, Shift for several)',
  multiSelection: (count) => `${count} entities selected: the components they all have are shown, differing values show "mixed"; an edit changes all of them in one undo step.`,
  removeScript: 'Remove this script',
  addComponent: 'Add a component',
  addComponentMenu: 'Add a component…',
  scripts: 'Scripts',
  mixed: 'mixed',
  eulerHint: 'Angles (degrees): around Z, then X, then Y (as in Stride)',
  none: '(none)',
  timelinePlay: 'Play (preview)',
  timelinePause: 'Pause',
  timelineThroughCamera: 'Look through the timeline camera (the camera track at this time)',
  timelineAddKey: "Add a key to the selected track at the playhead (the entity's current value)",
  timelineKeyTransform: "Key the selected entity's position and rotation at the playhead (adds the tracks if missing)",
  timelineDeleteKey: 'Delete the selected key',
  timelineClose: 'Close the timeline (the viewport goes back to the scene)',
  timelineTracks: { camera: 'Camera cuts', animation: 'Animation', sound: 'Sound', subtitle: 'Subtitles', event: 'Events' },
  timelineNoValue: (component, property) => `The entity has no ${component}.${property} to key`,
  timelineCurves: 'Curve editor (the selected property track as curves: drag keys up and down to change values, drag the handles to change tangents)',
  timelineInterpolation: 'Interpolation',
  timelineInterpolations: { constant: 'Step', linear: 'Linear', cubic: 'Curve' },
  timelineAutoTangent: 'Auto tangent',
  timelineFlatTangent: 'Flat tangent',
  timelineExport: 'Render to MP4 from the start (offline, with sound) into the exports folder of the project',
  timelineExporting: 'Rendering…',
  timelineExportPresets: { landscape1080: 'Landscape 1080p', vertical1080: 'Vertical 9:16', square1080: 'Square 1:1' },
  timelineExported: (path, seconds) => `Exported ${path} (${seconds.toFixed(0)} s)`,
  graphOpen: 'Node graph',
  paintLayers: 'Layers',
  particleOpen: 'Particle editor',
  polyEdit: 'Edit polygons',
  realtimeOn: 'The viewport redraws all the time (particles and weather keep moving); click to draw only when something changes and save the GPU',
  realtimeOff: 'The viewport draws only when something changes (input, edits), saving the GPU; click to redraw all the time so particles and weather keep moving',
  polyDone: 'Done',
  polyHint: 'Click vertices, edges or faces in the viewport (1, 2, 3 switch the mode; Shift or Ctrl adds), drag the gizmo to move (W, E, R: move, rotate, scale); Delete removes faces, Ctrl+Z undoes',
  polyModes: { vertex: 'Vertex', edge: 'Edge', face: 'Face' },
  polyAmount: 'Distance',
  polyOps: { extrude: 'Extrude', inset: 'Inset', bevel: 'Bevel', merge: 'Merge', split: 'Split', connect: 'Connect', delete: 'Delete faces', flip: 'Flip' },
  polyConnectNeedsFace: 'Connect needs two non-adjacent vertices of the same face',
  particleEmitters: 'Emitters',
  particleBake: 'Bake to flipbook',
  particleBaking: 'Baking…',
  particleBakeHint: (frames) => `${frames} frames in one atlas, saved under Textures; an entity playing it (one particle) is added next to this one`,
  particleBaked: (path, frames, seconds) => `Baked ${path} (${frames} frames, ${seconds.toFixed(2)} s)`,
  particleBakeFields: { columns: 'Columns', rows: 'Rows', size: 'Pixels per frame', seconds: 'Seconds', start: 'Start at', view: 'View' },
  particleBakeViews: { front: 'Front', side: 'Side', top: 'Top' },
  particleEmitter: (n) => `Emitter ${n}`,
  particleAddEmitter: 'Add emitter',
  particleRemoveEmitter: 'Remove this emitter',
  particleClose: 'Close the particle editor',
  particleNoSystem: 'Select an entity with a particle system and click "Particle editor" in the inspector',
  particleEmitterSettings: 'Emitter',
  particleAddModule: 'Add module',
  particleUp: 'Move up',
  particleDown: 'Move down',
  particleRemove: 'Remove this module',
  particleAddCurve: 'Add curve',
  particleRemoveCurve: 'Remove the curve',
  particleStacks: { spawners: 'Spawn', initializers: 'Initialize', updaters: 'Update', shapeBuilder: 'Shape', material: 'Material' },
  particleModules: {},
  particleFields: {},
  paintAddLayer: 'Add paint layer',
  paintLayer: (n) => `Layer ${n}`,
  paintColor: 'Color of this layer',
  paintRoughness: 'Roughness',
  paintMetalness: 'Metalness',
  paintStart: 'Paint',
  paintStop: 'Stop painting',
  paintRadius: 'Radius',
  paintHardness: 'Hardness',
  paintStrength: 'Strength',
  paintErase: 'Erase',
  paintHint: 'Hold the left button in the viewport to paint on the selected entity (Alt and the right button still move the camera); each stroke is saved into the mask',
  paintSelectEntity: 'Select the entity to paint in the scene first (it must use this material)',
  paintNoMask: 'The mask of this layer is not an image, so it cannot be painted (add a paint layer)',
  clipboardNotEntities: 'The clipboard does not hold copied entities',
  graphAddNode: 'Add node…',
  graphHint: 'Drag a node to move, drag the background to pan, wheel to zoom; drag from an output to an input to link; Delete removes the selected nodes or links',
  graphClose: 'Close the node graph',
  graphNoMaterial: 'Select a material in the asset browser and click "Node graph" in the inspector',
  graphOutput: 'Material output',
  graphOutputs: { baseColor: 'Base color', metalness: 'Metalness', roughness: 'Roughness', normal: 'Normal', emissive: 'Emissive', occlusion: 'Occlusion' },
  graphCategories: { input: 'Input', generator: 'Generator', math: 'Math', normal: 'Normal', mapping: 'Mapping' },
  graphNodes: {
    uv: 'UV', position: 'Position', time: 'Time', value: 'Value', color: 'Color', texture: 'Texture', noise: 'Noise', voronoi: 'Voronoi', bricks: 'Bricks', checker: 'Checker',
    gradient: 'Gradient', circle: 'Circle', add: 'Add', subtract: 'Subtract', multiply: 'Multiply', mix: 'Mix', invert: 'Invert', levels: 'Levels', power: 'Power', colorRamp: 'Color ramp',
    normalFromHeight: 'Normal from height', uvTransform: 'UV transform',
  },
  graphPorts: {},
  prefabMade: (path) => `Made prefab ${path}; the scene now has an instance of it (takes effect when the scene is saved)`,
  savedWithMissing: (count, first, more) => `Saved; ${count} required script propert${count === 1 ? 'y is' : 'ies are'} not set, so those scripts are not attached when playing: ${first.join(', ')}${more ? '…' : ''}`,
};

export const editorMessages: MessageTable<EditorMessages> = { 'zh-CN': zhCN, 'en-US': enUS };

/** 当前语言的界面文案。 */
export const t = translations(editorMessages);

/** "新建"菜单里这一项的文字。 */
export function newAssetLabel(option: NewAssetOption): string {
  return option.shape ? t.newAssetLabels.shape(t.shapes[option.shape]) : t.newAssetLabels[option.id as 'scene' | 'material' | 'ui' | 'timeline' | 'brush' | 'sdf' | 'poly'];
}
