import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Skeleton } from '@zerodep-dev/vue-tsx-pro-ui';
import type { Game } from '@stride-ts/engine';
import type { CSSProperties } from 'vue';
import { LIBRARY_DRAG_TYPE } from './LibraryPanel';
import { t } from './messages';
import type { EditorSession } from './session';

const styles = css.create({
  frame: { display: 'block', width: '100%', height: '100%', borderWidth: '0', backgroundColor: 'black' },
  status: { position: 'absolute', insetInlineStart: '_sm', insetBlockStart: '_sm', color: '_textMuted' },
  wrap: { position: 'relative', height: '100%' },
  // 打开游戏页面时盖住整个视口（游戏页面这时在起设备、打印启动日志），文字在中间；骨架是半透明的，底下垫一层不透明的表面
  opening: { position: 'absolute', inset: '0', display: 'grid', placeItems: 'center', backgroundColor: '_surface', color: '_textMuted' },
  openingShimmer: { position: 'absolute', inset: '0', borderRadius: '0' },
  guide: { position: 'absolute', inset: '0', pointerEvents: 'none', display: 'grid', placeItems: 'center', overflow: 'hidden' },
  // 从库窗口拖东西时盖在 iframe 上接放下（拖放的事件进了 iframe 就到不了编辑器）
  drop: { position: 'absolute', inset: '0' },
});

/**
 * 画幅参考线：画面里框出 aspect（宽 / 高）的画幅（以外压暗），里面是动作安全框（93%）和字幕安全框（90%）——拍短片时构图用。
 * 只是编辑器的叠加层，不进画面；容器查询的单位让框按视口大小贴合（比视口宽时上下留边，窄时左右留边）。
 */
function frameGuide(aspect: number) {
  const box: CSSProperties = { width: `min(100cqw, ${aspect} * 100cqh)`, height: `min(100cqh, 100cqw / ${aspect})`, position: 'relative', boxShadow: '0 0 0 100vmax rgba(0, 0, 0, 0.55)', outline: '1px solid rgba(255, 255, 255, 0.8)' };
  const safe = (percent: number): CSSProperties => ({ position: 'absolute', inset: `${(100 - percent) / 2}%`, border: '1px dashed rgba(255, 255, 255, 0.45)' });
  return (
    <div {...css.attrs(styles.guide)} style={{ containerType: 'size' }}>
      <div style={box}>
        <div style={safe(93)} title={t.actionSafe} />
        <div style={safe(90)} title={t.titleSafe} />
      </div>
    </div>
  );
}

/** 等游戏页面起来的间隔（毫秒）：它要建设备、加载场景。 */
const POLL_MS = 100;
const OPENING = Symbol('opening');

/**
 * 视口：游戏页面本身，嵌在同源的 iframe 里。编辑时地址带 `?debug&stride-edit`（游戏开在编辑状态，见引擎的 EditAgent），
 * 起来以后把场景交给会话；试玩时不带 stride-edit 重新打开，是一个干净的游戏。
 */
export const Viewport = _component(({ session, playing, onShortcut, onClipboard }: { session: EditorSession; playing: boolean; onShortcut: (event: KeyboardEvent) => void; onClipboard: (event: ClipboardEvent) => void }) => {
  // 正在打开时是骨架屏加 t.openingGame（换语言跟着换），出错时是报错，好了是空的
  let status = _state<string | typeof OPENING>(OPENING);
  let generation = 0;

  const loaded = async (event: Event) => {
    const frame = event.target as HTMLIFrameElement;
    const current = ++generation;
    session.detach();
    // 焦点在游戏里时，编辑器的快捷键（保存、撤销）、复制粘贴实体照样有用
    frame.contentWindow?.addEventListener('keydown', onShortcut);
    for (const type of ['copy', 'cut', 'paste'] as const) frame.contentWindow?.addEventListener(type, onClipboard);
    session.opening.value = !playing;
    if (playing) {
      status = '';
      return;
    }
    status = OPENING;
    const win = frame.contentWindow as (Window & { strideGame?: Game }) | null;
    // 游戏的 run 是异步的：等它的代理有了（loadContent 做完才建，根场景这时已经加载好；没有场景的游戏也是这时）
    while (current === generation && !win?.strideGame?.editor) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (current !== generation || !win?.strideGame) return;
    try {
      await session.attach(win.strideGame);
      status = '';
    } catch (error) {
      status = (error as Error).message;
    } finally {
      session.opening.value = false;
    }
  };

  return () => (
    <div {...css.attrs(styles.wrap)} aria-busy={status === OPENING || undefined}>
      <iframe {...css.attrs(styles.frame)} src={playing ? '/?debug' : '/?debug&stride-edit'} title={t.gameViewport} onLoad={(event: Event) => void loaded(event)} />
      {session.frameGuide.value > 0 && frameGuide(session.frameGuide.value)}
      {session.libraryDragging.value && (
        <div {...css.attrs(styles.drop)}
          onDragover={(event: DragEvent) => event.dataTransfer?.types.includes(LIBRARY_DRAG_TYPE) && event.preventDefault()}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            session.libraryDragging.value = false;
            const value = event.dataTransfer?.getData(LIBRARY_DRAG_TYPE);
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            if (value) void session.dropLibraryItem(value, event.clientX - rect.left, event.clientY - rect.top).catch((error: unknown) => (session.notice.value = (error as Error).message));
          }} />
      )}
      {status === OPENING && (
        <div {...css.attrs(styles.opening)} role="status">
          <Skeleton sx={styles.openingShimmer} />
          {t.openingGame}
        </div>
      )}
      {status && status !== OPENING && <span {...css.attrs(styles.status)}>{status}</span>}
    </div>
  );
});
