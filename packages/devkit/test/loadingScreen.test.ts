import { describe, expect, test } from 'vitest';
import { injectLoadingScreen } from '../src/loadingScreen.ts';

const PAGE = '<!doctype html><html><head><title>Game</title></head><body class="x"><canvas id="game"></canvas><script type="module" src="/src/main.ts"></script></body></html>';

describe('页面外壳的加载骨架', () => {
  test('样式进 head、元素和脚本紧跟在 body 开头（比应用自己的内容早）', () => {
    const html = injectLoadingScreen(PAGE);
    expect(html.indexOf('<style>')).toBeLessThan(html.indexOf('</head>'));
    expect(html).toContain('#stride-loading');
    expect(html.indexOf('<body class="x"><div id="stride-loading"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="stride-loading"')).toBeLessThan(html.indexOf('<canvas'));
  });

  test('注入过的页面不再注入第二次', () => {
    const once = injectLoadingScreen(PAGE);
    expect(injectLoadingScreen(once)).toBe(once);
  });

  test('内联脚本：嵌在 iframe 里摘掉、标题取页面的 title、60 秒兜底', () => {
    const html = injectLoadingScreen(PAGE);
    expect(html).toContain('window.top !== window');
    expect(html).toContain('document.title');
    expect(html).toContain('60000');
  });
});
