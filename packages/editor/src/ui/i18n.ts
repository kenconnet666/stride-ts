/**
 * 编辑器界面的多语言（P3 清单第 14 项）：界面上的文字都在翻译表里（messages.ts 是界面的，fieldMessages.ts 是组件和字段的），
 * 自带简体中文和英语；加一种语言就是每张表加一份，缺的表先找同一语种（zh-TW 用 zh-CN 的），再用英语（同 vue-tsx-pro 的
 * MessageTable）。
 *
 * 语言按 `?lang=`、上次在工具条里选的（localStorage）、浏览器的语言定；vue-tsx-pro 自己的文案（确定、取消……）跟着换（main.ts）。
 * 组件和会话（状态、报错）里都读 `translations(表)` 返回的对象：它转发到当前语言的表，渲染函数里读的跟着 locale 变。
 */
import type { MessageTable } from '@zerodep-dev/vue-tsx-pro-ui';
import { ref } from 'vue';

/** 自带的语言和它们在语言菜单里的名字。 */
export const LOCALES = { 'zh-CN': '简体中文', 'en-US': 'English' } as const;
export type Locale = keyof typeof LOCALES;

const STORAGE_KEY = 'stride-editor-locale';

/** 当前语言；改它（setLocale）界面马上换。 */
export const locale = ref<Locale>(initialLocale());

export function setLocale(code: Locale): void {
  locale.value = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // 存不了（隐私模式）时只是下次不记得
  }
}

/** 一张翻译表在当前语言下的文案；返回的对象一直转发到最新的语言。 */
export function translations<T extends object>(table: MessageTable<T>): T {
  return new Proxy({} as T, { get: (_, key) => Reflect.get(pick(table, locale.value), key) });
}

/** 这张表里 code 的那份：没有时用同一语种的，再没有用英语。 */
export function pick<T>(table: MessageTable<T>, code: string): T {
  const language = code.split('-')[0];
  const same = Object.keys(table).find((key) => key.split('-')[0] === language);
  return table[code] ?? (same === undefined ? undefined : table[same]) ?? table['en-US'];
}

function initialLocale(): Locale {
  const known = (code: string | null | undefined): Locale | undefined => {
    if (!code) return undefined;
    if (code in LOCALES) return code as Locale;
    const language = code.split('-')[0];
    return (Object.keys(LOCALES) as Locale[]).find((key) => key.split('-')[0] === language);
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // 读不了时按浏览器的语言
  }
  // 不在浏览器里（单测）时没有 location、navigator
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('lang');
  return known(query) ?? known(stored) ?? known(typeof navigator === 'undefined' ? undefined : navigator.language) ?? 'en-US';
}
