/**
 * 编辑器的界面（Vue 加 vue-tsx-pro，用户 2026-11-20 定）。由应用开发服务器上的 strideEditor 插件提供（server/vite.ts），
 * 地址是 EDITOR_UI_PATH；游戏页面嵌在里面的 iframe 里，和这个页面同源。
 */
import { createApp } from 'vue';
import { createUi, enUS, zhCN } from '@zerodep-dev/vue-tsx-pro-ui';
import { App } from './App';
import { locale } from './i18n/i18n';
import { EditorSession } from './session/EditorSession';
import { themePreference } from './session/theme';

const session = new EditorSession();
createApp(App, { session })
  // 主题按用户在主工具条上选的（session/theme.ts），页面的底色跟着；vue-tsx-pro 自己的文案（确定、取消……）跟着编辑器的语言
  .use(createUi({ theme: () => themePreference.theme, paintDocument: true, lang: () => (locale.value === 'zh-CN' ? zhCN : enUS) }))
  .mount('#app');
