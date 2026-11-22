/**
 * 编辑器的主题：组件库的内置主题（亮、暗、纸、午夜……）加“跟随系统”，选择记在本地存储里（下次打开、别的标签页都沿用）。
 * 入口交给 createUi，主工具条上的 ThemeSwitcher 切换。
 */
import { builtinSystemThemes, builtinThemes, createThemePreference } from '@zerodep-dev/vue-tsx-pro-ui';

export const themePreference = createThemePreference({
  themes: builtinThemes,
  system: builtinSystemThemes,
  storageKey: 'world-engine-editor.theme',
});
