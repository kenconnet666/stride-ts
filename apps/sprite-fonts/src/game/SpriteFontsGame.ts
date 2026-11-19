// SpriteFonts：没有场景，合成器的根渲染器是 FontRenderer（只用 SpriteBatch 画字）。字体先下载好用到的字的块，第一帧就齐。
import { Game, type GameTime } from '@stride-ts/engine';
import { FontRenderer, type FontRendererAssets } from './FontRenderer';

const FONTS = {
  staticFont: 'StaticFont', dynamicFont: 'DynamicFont', boldFont: 'BoldFont', italicFont: 'ItalicFont', aliasedFont: 'AliasedFont',
  antialiasedFont: 'AntialiasedFont', clearTypeFont: 'ClearTypeFont', japaneseFont: 'JapaneseFont', timesNewRoman: 'TimesNewRoman', headerFont: 'HeaderFont',
} as const;
const JAPANESE = 'Japanese dynamic sprite font\nあいうえおかきくけこ   天竜の\nアイウエオカキクケコ   幅八町の\n一二三四五六七八九十   梅雨濁り';
const STATS_INTERVAL = 0.25;

export class SpriteFontsGame extends Game {
  private readonly stats: HTMLElement;
  private statsTime = 0;

  constructor(stats: HTMLElement) {
    super();
    this.stats = stats;
  }

  protected override async loadContent(): Promise<void> {
    const entries = await Promise.all(Object.entries(FONTS).map(async ([key, name]) => {
      const font = await this.content.loadFont(`SpriteFonts/Shared/${name}`);
      await font.ensure(key === 'japaneseFont' ? JAPANESE : 'A');
      return [key, font] as const;
    }));
    this.rootRenderer = new FontRenderer(Object.fromEntries(entries) as unknown as FontRendererAssets);
  }

  protected override update(time: GameTime): void {
    super.update(time);
    if (time.total - this.statsTime < STATS_INTERVAL) return;
    this.statsTime = time.total;
    this.stats.textContent = `frame ${time.frameCount}  ${(1 / Math.max(time.elapsed, 1e-6)).toFixed(0)} fps`;
  }
}
