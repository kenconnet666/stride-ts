/**
 * 用户在系统、浏览器里设的偏好（CSS 的媒体查询），游戏照着调整自己：少放动画、提高对比、跟随深浅色。每次读都是当前的值，
 * 用户改了设置马上跟着变。
 *
 *   if (game.userPreferences.reducedMotion) camera.shake = 0;
 */
const QUERIES = {
  reducedMotion: '(prefers-reduced-motion: reduce)',
  highContrast: '(prefers-contrast: more)',
  dark: '(prefers-color-scheme: dark)',
} as const;

export class UserPreferences {
  readonly #lists = new Map<string, MediaQueryList>();

  /** 用户要少一些动画（晕动症）：镜头晃动、视差、闪烁这类效果该关掉或者减弱。 */
  get reducedMotion(): boolean {
    return this.#matches(QUERIES.reducedMotion);
  }

  /** 用户要更高的对比度：界面的文字和边框用对比更强的颜色。 */
  get highContrast(): boolean {
    return this.#matches(QUERIES.highContrast);
  }

  /** 系统的深浅色。 */
  get colorScheme(): 'light' | 'dark' {
    return this.#matches(QUERIES.dark) ? 'dark' : 'light';
  }

  #matches(query: string): boolean {
    // Node（测试、工具）里没有 matchMedia
    if (typeof matchMedia !== 'function') return false;
    let list = this.#lists.get(query);
    if (!list) this.#lists.set(query, (list = matchMedia(query)));
    return list.matches;
  }
}
