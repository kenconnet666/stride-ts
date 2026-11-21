/**
 * 精灵表面板（参考 Stride 的精灵表编辑器、Unity 的 Sprite Editor）：属性面板里开着的精灵表，下面一栏是精灵的列表，旁边是贴图，
 * 贴图上画着用这张贴图的每个精灵的框。操作：
 * - 拖空白处平移（小手），滚轮缩放；点一个框选中它（列表里也能选）；
 * - 拖选中的框挪区域，拖四边、四角的把手改大小，拖圆点挪原点（都按整像素）；
 * - 工具条：加精灵、删掉选中的，按网格切（列数 × 行数），自动切（不透明的像素连成的块，同 Unity 的 Automatic），
 *   切出来的替换这张贴图上原来的精灵；
 * - 精灵表是空的时候先选一张贴图，整张当第一个精灵。
 * 每次修改经 session.editInspected 存（同属性面板：稍等一下存），用到这个精灵表的精灵热重载。名字、每单位像素、九宫格的边框在
 * 属性面板里改。切图的算法在引擎（editor/spriteSlicing.ts），MCP 的 agent 用同一套。
 */
import { Crop, Grid3x3, Plus, ScanSearch, Trash2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, IconButton, NumberField, TextField, Tree, usePanZoom } from '@zerodep-dev/vue-tsx-pro-ui';
import { TEXTURE_EXTENSIONS, type SpriteSheetFile, type TextureRef } from '@stride-ts/engine/content-format';
import { autoRegions, DEFAULT_PIXELS_PER_UNIT, gridRegions, replaceSprites, type SpritePixels, type SpriteRegion } from '@stride-ts/engine/editor-sprites';
import { t } from './messages';
import type { EditorSession } from './session';

type Sprite = SpriteSheetFile['sprites'][number];

const styles = css.create({
  panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0', fontSize: '0.75rem' },
  toolbar: { display: 'flex', alignItems: 'center', gap: '_xs', paddingInline: '_sm', paddingBlock: '2px', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  grow: { flex: '1', color: '_textMuted', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  count: { width: '4.5em' },
  body: { flex: '1', minHeight: '0', display: 'flex' },
  list: { width: '180px', flexShrink: '0', borderInlineEndWidth: '1px', borderInlineEndStyle: 'solid', borderInlineEndColor: '_border' },
  viewport: { flex: '1', minWidth: '0', position: 'relative', overflow: 'hidden', cursor: 'grab', backgroundColor: '#2b2b2b', outline: 'none' },
  content: { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0' },
  image: { display: 'block', imageRendering: 'pixelated', backgroundImage: 'repeating-conic-gradient(#3a3a3a 0 25%, #303030 0 50%)', backgroundSize: '16px 16px' },
  overlay: { position: 'absolute', left: '0', top: '0', overflow: 'visible' },
  hint: { color: '_textMuted', padding: '_sm' },
  start: { display: 'flex', gap: '_xs', alignItems: 'center', padding: '_sm' },
});

/** 拖的是什么：整个框、哪条边或角（n、s、e、w 的组合）、原点。 */
type Grip = 'move' | 'center' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const CORNERS: readonly (readonly [Grip, number, number])[] = [['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5], ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5]];
const CURSORS: Readonly<Record<Grip, string>> = { move: 'move', center: 'crosshair', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
/** 把手在屏幕上的大小（像素，不跟着缩放变）。 */
const HANDLE = 8;

export const SpriteSheetPanel = _component(({ session }: { session: EditorSession }) => {
  let selected = _state(0);
  let viewport = _state.raw<HTMLElement | null>(null);
  let image = _state.raw<HTMLImageElement | null>(null);
  let loadedUrl = '';
  let start = _state('');
  let columns = _state<number | null>(4);
  let rows = _state<number | null>(4);
  let notice = _state('');
  // 按在框、把手上是拖它们，不平移；滚轮在哪都缩放
  const view = usePanZoom({ viewport: () => viewport, min: 0.05, max: 32, filter: (event) => event.type === 'wheel' || !(event.target as Element | null)?.closest?.('[data-sprite-grip]') });
  /** 整张贴图放进视口：像素画常常很小，fit 不放大，再按视口放大到正好装下（最多 8 倍）。 */
  const fitImage = (target: HTMLImageElement) => {
    view.fit({ width: target.naturalWidth, height: target.naturalHeight }, 16);
    const box = viewport?.getBoundingClientRect();
    if (!box) return;
    const scale = Math.min(8, (box.width - 32) / target.naturalWidth, (box.height - 32) / target.naturalHeight);
    if (scale > view.scale) view.zoomTo(scale, { x: box.width / 2, y: box.height / 2 });
  };

  const sheet = (): SpriteSheetFile | undefined => {
    const inspected = session.inspected.value;
    return inspected?.kind === 'spriteSheet' ? (inspected.content as unknown as SpriteSheetFile) : undefined;
  };
  const sprites = () => sheet()?.sprites ?? [];
  const current = (): Sprite | undefined => sprites()[Math.min(selected, sprites().length - 1)];

  /** 浏览器能直接显示的那个文件（压成 KTX2 的贴图用旁边的源图片）；没有时是 undefined。 */
  const imageUrl = (texture: TextureRef): string | undefined => {
    const root = session.project.value?.contentUrl;
    if (root === null || root === undefined) return undefined;
    const files = session.assets.value.find((asset) => asset.kind === 'image' && asset.path === texture.texture)?.files ?? [];
    const shown = files.find((file) => /\.(png|jpe?g|webp|svg)$/i.test(file)) ?? (texture.encoding && texture.encoding !== 'ktx2' ? texture.texture + TEXTURE_EXTENSIONS[texture.encoding] : undefined);
    return shown === undefined ? undefined : `/${root}${shown}`;
  };
  /** 选中的精灵的贴图加载好了放进 image；换了贴图时把整张图放进视口。 */
  const load = (url: string | undefined) => {
    if (url === loadedUrl) return;
    loadedUrl = url ?? '';
    image = null;
    if (!url) return;
    const next = new Image();
    next.onload = () => {
      if (loadedUrl !== url) return;
      image = next;
      fitImage(next);
    };
    next.src = url;
  };
  const pixels = (): SpritePixels | undefined => {
    if (!image) return undefined;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: data.width, height: data.height, data: data.data };
  };

  const setSprites = (next: readonly Sprite[]) => session.editInspected(['sprites'], next);
  const setSprite = (index: number, change: Partial<Sprite>) => session.editInspected(['sprites', index], { ...sprites()[index]!, ...change });

  /** 新的精灵（用 template 的贴图、每单位像素），名字按序号。 */
  const makeSprite = (template: Pick<Sprite, 'texture'> & Partial<Sprite>, region: SpriteRegion, name: string): Sprite => ({
    name, texture: template.texture, region: [...region], pixelsPerUnit: template.pixelsPerUnit ?? DEFAULT_PIXELS_PER_UNIT, center: [0, 0], centerFromMiddle: true,
  });
  /** 切出来的区域替换这张贴图上原来的精灵（别的贴图的留着，同 MCP 的 slice_sprites），选中第一个。 */
  const replaceSlices = (regions: readonly SpriteRegion[]) => {
    const template = current(), file = sheet();
    if (!template || !file || regions.length === 0) {
      notice = t.spriteSheet.nothingFound;
      return;
    }
    const replaced = replaceSprites(file, template.texture, regions, template.pixelsPerUnit);
    setSprites(replaced.sheet.sprites);
    selected = replaced.first;
    notice = t.spriteSheet.sliced(regions.length);
  };
  const sliceGrid = () => {
    if (!image || !columns || !rows) return;
    replaceSlices(gridRegions(image.naturalWidth, image.naturalHeight, { columns, rows }, pixels()));
  };
  const sliceAuto = () => {
    const found = pixels();
    if (found) replaceSlices(autoRegions(found));
  };
  const addSprite = () => {
    const template = current();
    if (!template || !image) return;
    const size = Math.max(1, Math.round(Math.min(image.naturalWidth, image.naturalHeight) / 4));
    setSprites([...sprites(), makeSprite(template, [Math.round((image.naturalWidth - size) / 2), Math.round((image.naturalHeight - size) / 2), size, size], `Sprite${sprites().length}`)]);
    selected = sprites().length;
  };
  const removeSprite = () => {
    if (!current()) return;
    setSprites(sprites().filter((_, i) => i !== selected));
    selected = Math.max(0, selected - 1);
  };
  /** 空的精灵表：整张贴图当第一个精灵。 */
  const startFrom = (path: string) => {
    const texture = { texture: path, encoding: imageEncoding(path) };
    const url = imageUrl(texture);
    if (!url) {
      notice = t.spriteSheet.noImage(path);
      return;
    }
    const probe = new Image();
    probe.onload = () => {
      setSprites([makeSprite({ texture }, [0, 0, probe.naturalWidth, probe.naturalHeight], path.slice(path.lastIndexOf('/') + 1))]);
      selected = 0;
    };
    probe.onerror = () => (notice = t.spriteSheet.noImage(path));
    probe.src = url;
  };
  const imageEncoding = (path: string): NonNullable<TextureRef['encoding']> => {
    const file = session.assets.value.find((asset) => asset.kind === 'image' && asset.path === path)?.files.find((name) => !name.endsWith('.ktx2'));
    const extension = file?.slice(file.lastIndexOf('.')).toLowerCase();
    return extension === '.jpg' || extension === '.jpeg' ? 'jpeg' : extension === '.webp' ? 'webp' : extension === '.svg' ? 'svg' : extension === '.png' ? 'png' : 'ktx2';
  };

  /** 按下一个把手：之后的指针移动按图片像素算出新的区域或原点。 */
  const grab = (event: PointerEvent, index: number, grip: Grip) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    selected = index;
    const sprite = sprites()[index]!;
    const [x, y, w, h] = sprite.region;
    const [cx, cy] = sprite.center;
    const startX = event.clientX, startY = event.clientY;
    const move = (moved: PointerEvent) => {
      const dx = Math.round((moved.clientX - startX) / view.scale), dy = Math.round((moved.clientY - startY) / view.scale);
      if (grip === 'center') return setSprite(index, { center: [cx + dx, cy + dy] });
      let [left, top, right, bottom] = [x, y, x + w, y + h];
      if (grip === 'move') [left, right, top, bottom] = [left + dx, right + dx, top + dy, bottom + dy];
      if (grip.includes('w')) left = Math.min(left + dx, right - 1);
      if (grip.includes('e')) right = Math.max(right + dx, left + 1);
      if (grip.includes('n')) top = Math.min(top + dy, bottom - 1);
      if (grip.includes('s')) bottom = Math.max(bottom + dy, top + 1);
      setSprite(index, { region: [left, top, right - left, bottom - top] });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 贴图上一个精灵的框；选中的带把手和原点。 */
  const frame = (sprite: Sprite, index: number) => {
    const [x, y, w, h] = sprite.region;
    const active = index === selected;
    const handle = HANDLE / view.scale;
    const centerX = x + (sprite.centerFromMiddle ? w / 2 : 0) + sprite.center[0], centerY = y + (sprite.centerFromMiddle ? h / 2 : 0) + sprite.center[1];
    return (
      <g>
        <rect data-sprite-grip="" x={x} y={y} width={w} height={h} fill={active ? 'rgba(255,170,50,0.12)' : 'transparent'} stroke={active ? '#ffaa33' : '#5fb0ff'} stroke-width={active ? 2 : 1}
          vector-effect="non-scaling-stroke" style={{ cursor: active ? CURSORS.move : 'pointer' }} onPointerdown={(event: PointerEvent) => grab(event, index, 'move')}>
          <title>{sprite.name}</title>
        </rect>
        {active && CORNERS.map(([grip, fx, fy]) => (
          <rect data-sprite-grip="" x={x + w * fx - handle / 2} y={y + h * fy - handle / 2} width={handle} height={handle} fill="#ffaa33" style={{ cursor: CURSORS[grip] }}
            onPointerdown={(event: PointerEvent) => grab(event, index, grip)} />
        ))}
        {active && (
          <circle data-sprite-grip="" cx={centerX} cy={centerY} r={handle / 1.6} fill="none" stroke="#ff4d6d" stroke-width={2} vector-effect="non-scaling-stroke" style={{ cursor: CURSORS.center }}
            onPointerdown={(event: PointerEvent) => grab(event, index, 'center')}>
            <title>{t.spriteSheet.center}</title>
          </circle>
        )}
      </g>
    );
  };

  return () => {
    const file = sheet();
    if (!file) return <div {...css.attrs(styles.hint)}>{t.spriteSheet.none}</div>;
    const sprite = current();
    const url = sprite ? imageUrl(sprite.texture) : undefined;
    load(url);
    const images = session.assets.value.filter((asset) => asset.kind === 'image').map((asset) => asset.path);
    return (
      <div {...css.attrs(styles.panel)}>
        <div {...css.attrs(styles.toolbar)} role="toolbar" aria-label={t.toolWindows.sprites}>
          <IconButton size="sm" variant="ghost" icon={Plus} aria-label={t.spriteSheet.add} title={t.spriteSheet.add} disabled={!image} onClick={addSprite} />
          <IconButton size="sm" variant="ghost" icon={Trash2} aria-label={t.spriteSheet.remove} title={t.spriteSheet.remove} disabled={!sprite} onClick={removeSprite} />
          <NumberField {...css.attrs(styles.count)} size="sm" stepper={false} min={1} step={1} aria-label={t.spriteSheet.columns} title={t.spriteSheet.columns} _value={columns} onUpdate:_value={(value: number | null) => (columns = value)} />
          ×
          <NumberField {...css.attrs(styles.count)} size="sm" stepper={false} min={1} step={1} aria-label={t.spriteSheet.rows} title={t.spriteSheet.rows} _value={rows} onUpdate:_value={(value: number | null) => (rows = value)} />
          <Button size="sm" variant="soft" tone="neutral" icon={Grid3x3} disabled={!image} onClick={sliceGrid}>{t.spriteSheet.grid}</Button>
          <Button size="sm" variant="soft" tone="neutral" icon={ScanSearch} disabled={!image} onClick={sliceAuto}>{t.spriteSheet.auto}</Button>
          <IconButton size="sm" variant="ghost" icon={Crop} aria-label={t.spriteSheet.fit} title={t.spriteSheet.fit} disabled={!image} onClick={() => image && fitImage(image)} />
          <span {...css.attrs(styles.grow)} role="status">{notice || (sprite ? `${sprite.name} · ${sprite.region.join(', ')}` : '')}</span>
        </div>
        {file.sprites.length === 0 ? (
          <div {...css.attrs(styles.start)}>
            <TextField size="sm" list="stride-sprite-images" aria-label={t.spriteSheet.texture} placeholder={t.spriteSheet.texture} _value={start} onUpdate:_value={(value: string) => (start = value)} />
            <datalist id="stride-sprite-images">{images.map((path) => <option value={path} />)}</datalist>
            <Button size="sm" variant="soft" disabled={!start} onClick={() => startFrom(start)}>{t.spriteSheet.startFrom}</Button>
          </div>
        ) : (
          <div {...css.attrs(styles.body)}>
            <div {...css.attrs(styles.list)}>
              <Tree
                aria-label={t.spriteSheet.list}
                items={file.sprites.map((item, index) => ({ index, name: item.name || `#${index}` }))}
                getKey={(item: unknown) => String((item as { index: number }).index)}
                getLabel={(item: unknown) => (item as { name: string }).name}
                _selected={[String(Math.min(selected, file.sprites.length - 1))]}
                getChildren={() => []}
                hasChildren={() => false}
                onUpdate:_selected={(keys: string[]) => {
                  if (keys[0] !== undefined) selected = Number(keys[0]);
                }}
              />
            </div>
            <div {...css.attrs(styles.viewport)} ref={(element: unknown) => (viewport = element as HTMLElement | null)} tabindex="0" {...view.viewportProps}>
              {!url && <div {...css.attrs(styles.hint)}>{t.spriteSheet.cannotShow}</div>}
              {url && image && (
                <div {...css.attrs(styles.content)} style={{ transform: view.transform, width: `${image.naturalWidth}px`, height: `${image.naturalHeight}px` }}>
                  <img {...css.attrs(styles.image)} src={url} width={image.naturalWidth} height={image.naturalHeight} alt="" draggable={false} />
                  <svg {...css.attrs(styles.overlay)} width={image.naturalWidth} height={image.naturalHeight} viewBox={`0 0 ${image.naturalWidth} ${image.naturalHeight}`}>
                    {/* 选中的画在最后（在上面，把手不被别的框挡住） */}
                    {file.sprites.map((item, index) => (index !== selected && item.texture.texture === sprite!.texture.texture ? frame(item, index) : null))}
                    {sprite && frame(sprite, Math.min(selected, file.sprites.length - 1))}
                  </svg>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };
});
