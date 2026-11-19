/**
 * 编辑器的界面（Vue 加 vue-tsx-pro，用户 2026-11-20 定）。由应用开发服务器上的 strideEditor 插件提供（server/vite.ts），
 * 地址是 EDITOR_UI_PATH；游戏页面嵌在里面的 iframe 里，和这个页面同源。
 */
import { createApp } from 'vue';
import { createUi, darkTheme, lightTheme } from '@zerodep-dev/vue-tsx-pro-ui';
import { App } from './App';
import { EditorSession } from './session';

const session = new EditorSession();
createApp(App, { session })
  .use(createUi({ theme: { light: lightTheme, dark: darkTheme } }))
  .mount('#app');
