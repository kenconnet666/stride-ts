/**
 * 精灵表面板（参考 Stride 的精灵表编辑器、Unity 的 Sprite Editor）：属性面板里开着的精灵表，下面一栏是精灵的列表，旁边是贴图，
 * 贴图上画着用这张贴图的每个精灵的框。操作：
 * - 贴图和框是 vue-tsx-pro 的 ImageRegions：拖空白处平移，滚轮缩放；点一个框选中它（列表里也能选）；拖选中的框挪区域，拖四边、
 *   四角的把手改大小，拖圆点挪原点（都按整像素），方向键挪、Alt 加方向键改大小；
 * - 工具条：加精灵、删掉选中的，按网格切（列数 × 行数），自动切（不透明的像素连成的块，同 Unity 的 Automatic），
 *   切出来的替换这张贴图上原来的精灵；
 * - 精灵表是空的时候先选一张贴图，整张当第一个精灵。
 * 每次修改经 session.editInspected 存（同属性面板：稍等一下存），用到这个精灵表的精灵热重载。名字、每单位像素、九宫格的边框在
 * 属性面板里改。切图的算法在引擎（editor/spriteSlicing.ts），MCP 的 agent 用同一套。
 */
import { Crop, Grid3x3, Plus, ScanSearch, Trash2 } from '@lucide/icons';
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Button, createImageRegionsController, Empty, Flex, IconButton, ImageRegions, NumberField, Text, TextField, Toolbar, Tree, type ImageRegion, type ImageRegionChange } from '@zerodep-dev/vue-tsx-pro-ui';
import type { SpriteSheetFile, TextureRef } from '@stride-ts/engine/content-format';
import { autoRegions, DEFAULT_PIXELS_PER_UNIT, gridRegions, replaceSprites, type SpritePixels, type SpriteRegion } from '@stride-ts/engine/editor-sprites';
import { t } from '../i18n/messages';
import type { EditorSession } from '../session/EditorSession';

type Sprite = SpriteSheetFile['sprites'][number];

const styles = css.create({
  panel: { height: '100%', minHeight: '0', fontSize: '0.75rem' },
  count: { width: '4.5em' },
  body: { flex: '1', minHeight: '0' },
  list: { width: '180px', flexShrink: '0', borderInlineEndWidth: '1px', borderInlineEndStyle: 'solid', borderInlineEndColor: '_border' },
  regions: { flex: '1', minWidth: '0' },
  start: { padding: '_sm' },
});

export const SpriteSheetPanel = _component(({ session }: { session: EditorSession }) => {
  let selected = _state(0);
  let image = _state.raw<HTMLImageElement | null>(null);
  let loadedUrl = '';
  let start = _state('');
  let columns = _state<number | null>(4);
  let rows = _state<number | null>(4);
  let notice = _state('');
  /** 贴图视口的命令（工具条的“整张放进视口”） */
  const view = createImageRegionsController();
  const sheet = (): SpriteSheetFile | undefined => {
    const inspected = session.inspected.value;
    return inspected?.kind === 'spriteSheet' ? (inspected.content as unknown as SpriteSheetFile) : undefined;
  };
  const sprites = () => sheet()?.sprites ?? [];
  const current = (): Sprite | undefined => sprites()[Math.min(selected, sprites().length - 1)];

  /** 浏览器能直接显示的那个文件（压成 KTX2 的贴图用旁边的源图片）；没有时是 undefined。 */
  const imageUrl = (texture: TextureRef): string | undefined => session.imageUrl(texture.texture, texture.encoding);
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

  /** 一个精灵在贴图上的框：原点是框里的偏移（centerFromMiddle 时从中心算），框的锚点是贴图上的位置。 */
  const regionOf = (sprite: Sprite, index: number): ImageRegion => {
    const [x, y, w, h] = sprite.region;
    return {
      id: String(index), label: sprite.name || `#${index}`, x, y, width: w, height: h,
      anchor: { x: x + (sprite.centerFromMiddle ? w / 2 : 0) + sprite.center[0], y: y + (sprite.centerFromMiddle ? h / 2 : 0) + sprite.center[1] },
    };
  };
  /** 框改了（挪、改大小、挪原点）：换回精灵的区域和原点。 */
  const onRegionChange = (region: ImageRegion, _change: ImageRegionChange) => {
    const index = Number(region.id);
    const sprite = sprites()[index];
    if (!sprite) return;
    const anchor = region.anchor ?? { x: region.x, y: region.y };
    const originX = region.x + (sprite.centerFromMiddle ? region.width / 2 : 0), originY = region.y + (sprite.centerFromMiddle ? region.height / 2 : 0);
    setSprite(index, { region: [region.x, region.y, region.width, region.height], center: [anchor.x - originX, anchor.y - originY] });
  };

  return () => {
    const file = sheet();
    if (!file) return <Empty size="sm" icon={false} description={t.spriteSheet.none} />;
    const sprite = current();
    const url = sprite ? imageUrl(sprite.texture) : undefined;
    load(url);
    const images = session.assets.value.filter((asset) => asset.kind === 'image').map((asset) => asset.path);
    return (
      <Flex direction="column" sx={styles.panel}>
        <Toolbar docked="top" aria-label={t.toolWindows.sprites}>
          <IconButton size="sm" variant="ghost" icon={Plus} aria-label={t.spriteSheet.add} title={t.spriteSheet.add} disabled={!image} onClick={addSprite} />
          <IconButton size="sm" variant="ghost" icon={Trash2} aria-label={t.spriteSheet.remove} title={t.spriteSheet.remove} disabled={!sprite} onClick={removeSprite} />
          <NumberField {...css.attrs(styles.count)} size="sm" stepper={false} min={1} step={1} aria-label={t.spriteSheet.columns} title={t.spriteSheet.columns} _value={columns} onUpdate:_value={(value: number | null) => (columns = value)} />
          ×
          <NumberField {...css.attrs(styles.count)} size="sm" stepper={false} min={1} step={1} aria-label={t.spriteSheet.rows} title={t.spriteSheet.rows} _value={rows} onUpdate:_value={(value: number | null) => (rows = value)} />
          <Button size="sm" variant="soft" tone="neutral" icon={Grid3x3} disabled={!image} onClick={sliceGrid}>{t.spriteSheet.grid}</Button>
          <Button size="sm" variant="soft" tone="neutral" icon={ScanSearch} disabled={!image} onClick={sliceAuto}>{t.spriteSheet.auto}</Button>
          <IconButton size="sm" variant="ghost" icon={Crop} aria-label={t.spriteSheet.fit} title={t.spriteSheet.fit} disabled={!image} onClick={() => view.fit()} />
          <Flex grow>
            <Text tone="muted" truncate role="status">{notice || (sprite ? `${sprite.name} · ${sprite.region.join(', ')}` : '')}</Text>
          </Flex>
        </Toolbar>
        {file.sprites.length === 0 ? (
          <Flex align="center" gap="xs" sx={styles.start}>
            <TextField size="sm" list="stride-sprite-images" aria-label={t.spriteSheet.texture} placeholder={t.spriteSheet.texture} _value={start} onUpdate:_value={(value: string) => (start = value)} />
            <datalist id="stride-sprite-images">{images.map((path) => <option value={path} />)}</datalist>
            <Button size="sm" variant="soft" disabled={!start} onClick={() => startFrom(start)}>{t.spriteSheet.startFrom}</Button>
          </Flex>
        ) : (
          <Flex sx={styles.body}>
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
            {url ? (
              <ImageRegions
                sx={styles.regions}
                src={url}
                // 只画用这张贴图的精灵
                regions={file.sprites.flatMap((item, index) => (item.texture.texture === sprite!.texture.texture ? [regionOf(item, index)] : []))}
                _selected={String(Math.min(selected, file.sprites.length - 1))}
                onUpdate:_selected={(id: string | null) => id !== null && (selected = Number(id))}
                anchors
                pixelated
                controller={view}
                onRegionChange={onRegionChange}
                aria-label={t.spriteSheet.list}
              />
            ) : <Empty size="sm" icon={false} description={t.spriteSheet.cannotShow} />}
          </Flex>
        )}
      </Flex>
    );
  };
});
