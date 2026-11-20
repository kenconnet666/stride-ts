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
  readonly snapStep: { readonly [K in 'translate' | 'rotate' | 'scale']: { readonly label: string; readonly title: string } };
  readonly prefabTitle: (path: string) => string;
  readonly backToScene: (name: string) => string;
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
  readonly pickAsset: string;
  readonly moveRename: string;
  readonly delete: string;
  readonly open: string;
  readonly newAsset: string;
  readonly newAssetMenu: string;
  readonly newAssetLabels: { readonly scene: string; readonly material: string; readonly ui: string; readonly timeline: string; readonly brush: string; readonly shape: (shape: string) => string };
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
  readonly assetLabels: { readonly material: string; readonly model: string; readonly timeline: string; readonly brush: string };
  readonly assetHint: (kind: string, path: string) => string;
  readonly instanceOf: (prefab: string) => string;
  readonly memberOf: (prefab: string, instance: string, member: string) => string;
  readonly instanceChanges: (own: number, removed: number) => string;
  readonly scriptNeedsComponents: (script: string, components: readonly string[]) => string;
  readonly removedRequired: (component: string, dependents: readonly string[]) => string;
  readonly sceneSettingsHint: (scene: string) => string;
  readonly remove: (what: string) => string;
  readonly addSetting: string;
  readonly addSettingMenu: string;
  readonly sceneNotOpen: string;
  readonly pickEntity: string;
  readonly multiSelection: (count: number) => string;
  readonly removeScript: string;
  readonly addComponent: string;
  readonly addComponentMenu: string;
  readonly scripts: string;
  // 字段
  readonly mixed: string;
  readonly requiredUnset: (field: string) => string;
  readonly setValue: string;
  readonly add: string;
  readonly setNull: (field: string) => string;
  readonly removeField: (field: string) => string;
  readonly eulerHint: string;
  readonly none: string;
  readonly defaultItem: string;
  readonly removeLast: string;
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
  snapStep: {
    translate: { label: '移动', title: '移动的步长（米）' },
    rotate: { label: '旋转', title: '旋转的步长（度）' },
    scale: { label: '缩放', title: '缩放的步长（倍数）' },
  },
  prefabTitle: (path) => `预制体 ${path}`,
  backToScene: (name) => `回到场景 ${name}`,
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
  pickAsset: '选一个资源或文件夹',
  moveRename: '移动 / 改名',
  delete: '删除',
  open: '打开',
  newAsset: '新建资源',
  newAssetMenu: '新建……',
  newAssetLabels: { scene: '场景', material: '材质', ui: 'UI 页面', timeline: '时间轴', brush: '白盒（布尔建模）', shape: (shape) => `基本形状：${shape}` },
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
  assetLabels: { material: '材质', model: '模型', timeline: '时间轴', brush: '白盒' },
  assetHint: (kind, path) => `${kind} ${path}：改了马上存进资源文件，视口里用到它的实体跟着变。`,
  instanceOf: (prefab) => `预制体 ${prefab} 的实例`,
  memberOf: (prefab, instance, member) => `预制体 ${prefab} 的实例 ${instance} 里的 ${member}`,
  instanceChanges: (own, removed) => `${own > 0 ? `，这个实体改了 ${own} 处` : ''}${removed > 0 ? `，去掉了 ${removed} 个实体` : ''}。改的值记在实例上，和预制体一样时不记。`,
  scriptNeedsComponents: (script, components) => `${script} 要实体上有 ${components.join('、')}，场景文件里加不了，试玩时这个脚本不挂`,
  removedRequired: (component, dependents) => `去掉了 ${component}；${dependents.join('、')} 要它，试玩时不起作用`,
  sceneSettingsHint: (scene) => `场景 ${scene} 的设置（在场景树或视口里选实体看实体的）。合成器、偏移改了马上看得见；物理、导航试玩时用上。`,
  remove: (what) => `去掉 ${what}`,
  addSetting: '添加设置',
  addSettingMenu: '添加设置……',
  sceneNotOpen: '场景还没打开',
  pickEntity: '在场景树或视口里选一个实体（Ctrl、Shift 多选）',
  multiSelection: (count) => `选中了 ${count} 个实体：显示它们都有的组件，值不一样的显示"多个值"；改一处改所有的，一步撤销。`,
  removeScript: '去掉这个脚本',
  addComponent: '添加组件',
  addComponentMenu: '添加组件……',
  scripts: '脚本',
  mixed: '多个值',
  requiredUnset: (field) => `${field}：必填，还没设`,
  setValue: '设置',
  add: '添加',
  setNull: (field) => `${field} 设成 null`,
  removeField: (field) => `去掉 ${field}`,
  eulerHint: '角度（度），先绕 Z、再绕 X、再绕 Y（同 Stride）',
  none: '（无）',
  defaultItem: '（默认）',
  removeLast: '去掉最后一项',
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
  snapStep: {
    translate: { label: 'Move', title: 'Move step (meters)' },
    rotate: { label: 'Rotate', title: 'Rotation step (degrees)' },
    scale: { label: 'Scale', title: 'Scale step (factor)' },
  },
  prefabTitle: (path) => `Prefab ${path}`,
  backToScene: (name) => `Back to scene ${name}`,
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
  pickAsset: 'Pick an asset or a folder',
  moveRename: 'Move / rename',
  delete: 'Delete',
  open: 'Open',
  newAsset: 'New asset',
  newAssetMenu: 'New…',
  newAssetLabels: { scene: 'Scene', material: 'Material', ui: 'UI page', timeline: 'Timeline', brush: 'Greybox (CSG)', shape: (shape) => `Shape: ${shape}` },
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
  assetLabels: { material: 'Material', model: 'Model', timeline: 'Timeline', brush: 'Greybox' },
  assetHint: (kind, path) => `${kind} ${path}: changes are saved to the asset file at once, and the entities that use it in the viewport follow.`,
  instanceOf: (prefab) => `Instance of prefab ${prefab}`,
  memberOf: (prefab, instance, member) => `${member} in ${instance}, an instance of prefab ${prefab}`,
  instanceChanges: (own, removed) => `${own > 0 ? `; ${own} change${own === 1 ? '' : 's'} on this entity` : ''}${removed > 0 ? `; ${removed} entit${removed === 1 ? 'y' : 'ies'} removed` : ''}. Changes are stored on the instance, and values equal to the prefab's are not.`,
  scriptNeedsComponents: (script, components) => `${script} needs ${components.join(', ')} on the entity, which scene files cannot add; the script is not attached when playing`,
  removedRequired: (component, dependents) => `Removed ${component}; ${dependents.join(', ')} need${dependents.length === 1 ? 's' : ''} it and will not work when playing`,
  sceneSettingsHint: (scene) => `Settings of scene ${scene} (select an entity in the scene tree or the viewport to see its own). Compositor and offset changes show at once; physics and navigation apply when playing.`,
  remove: (what) => `Remove ${what}`,
  addSetting: 'Add a setting',
  addSettingMenu: 'Add a setting…',
  sceneNotOpen: 'No scene is open yet',
  pickEntity: 'Select an entity in the scene tree or the viewport (Ctrl, Shift for several)',
  multiSelection: (count) => `${count} entities selected: the components they all have are shown, differing values show "mixed"; an edit changes all of them in one undo step.`,
  removeScript: 'Remove this script',
  addComponent: 'Add a component',
  addComponentMenu: 'Add a component…',
  scripts: 'Scripts',
  mixed: 'mixed',
  requiredUnset: (field) => `${field}: required, not set yet`,
  setValue: 'Set',
  add: 'Add',
  setNull: (field) => `Set ${field} to null`,
  removeField: (field) => `Remove ${field}`,
  eulerHint: 'Angles (degrees): around Z, then X, then Y (as in Stride)',
  none: '(none)',
  defaultItem: '(default)',
  removeLast: 'Remove the last one',
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
  prefabMade: (path) => `Made prefab ${path}; the scene now has an instance of it (takes effect when the scene is saved)`,
  savedWithMissing: (count, first, more) => `Saved; ${count} required script propert${count === 1 ? 'y is' : 'ies are'} not set, so those scripts are not attached when playing: ${first.join(', ')}${more ? '…' : ''}`,
};

export const editorMessages: MessageTable<EditorMessages> = { 'zh-CN': zhCN, 'en-US': enUS };

/** 当前语言的界面文案。 */
export const t = translations(editorMessages);

/** "新建"菜单里这一项的文字。 */
export function newAssetLabel(option: NewAssetOption): string {
  return option.shape ? t.newAssetLabels.shape(t.shapes[option.shape]) : t.newAssetLabels[option.id as 'scene' | 'material' | 'ui' | 'timeline' | 'brush'];
}
