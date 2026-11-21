/**
 * 声音资源在属性面板上方的音效生成器（S2）：合成的音效（encoding 是 'synth'，引擎 audio/soundSynth.ts）按类别随机出一个、
 * 在现在的参数附近变一点、试听；参数在下面的字段里逐个调，调了自动再放一遍（同 sfxr），存和热重载照属性面板的做法。
 * 音频文件的声音只有试听（放旁边的音频文件）。
 */
import { _component } from '@zerodep-dev/vue-tsx-pro-tsx';
import { css } from '@zerodep-dev/vue-tsx-pro-tsx/styles';
import { Dices, Play, Shuffle, Square } from '@lucide/icons';
import { Button } from '@zerodep-dev/vue-tsx-pro-ui';
import { mutateSound, seededRandom, soundSynth, SOUND_PRESETS, SOUND_SYNTH_RATE, synthesizeSound, type SoundPreset, type SoundSynth } from '@stride-ts/engine/audio-synth';
import type { SoundFile } from '@stride-ts/engine/content-format';
import { onUnmounted, watch } from 'vue';
import { t } from './messages';
import type { EditorSession } from './session';

const styles = css.create({
  box: { display: 'flex', flexDirection: 'column', gap: '4px', paddingBlock: '_xs', borderBlockEndWidth: '1px', borderBlockEndStyle: 'solid', borderBlockEndColor: '_border' },
  title: { fontWeight: '600' },
  row: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  hint: { color: '_textMuted', fontSize: '0.8em' },
});

const PRESETS: readonly SoundPreset[] = ['pickup', 'laser', 'explosion', 'powerUp', 'hit', 'jump', 'blip', 'random'];
/** 调参数以后等这么久没再改才自动试听（拖数值时不连着放）。 */
const AUTO_PLAY_DELAY = 250;

export const SoundGenerator = _component(({ session }: { session: EditorSession }) => {
  let context: AudioContext | undefined;
  let voice: AudioBufferSourceNode | undefined;
  let autoPlay: ReturnType<typeof setTimeout> | undefined;
  /** 上一次放的是哪组参数：按钮换参数时已经放过了，参数变了不再自动放一遍。 */
  let played: string | undefined;
  // 显示的时长要合成一遍才知道（几到几十毫秒）：参数没变就不重算
  let measured: { readonly key: string; readonly seconds: number } | undefined;
  const lengthOf = (synth: SoundSynth) => {
    const key = JSON.stringify(synth);
    if (measured?.key !== key) measured = { key, seconds: synthesizeSound(synth).length / SOUND_SYNTH_RATE };
    return measured.seconds;
  };

  const sound = () => {
    const inspected = session.inspected.value;
    return inspected?.kind === 'sound' ? { path: inspected.path, file: inspected.content as unknown as SoundFile } : undefined;
  };

  const stop = () => {
    voice?.stop();
    voice = undefined;
  };

  /** 放一遍：合成的现算，音频文件的取旁边的文件解码。 */
  const play = async () => {
    const current = sound();
    if (!current) return;
    stop();
    context ??= new AudioContext();
    const { path, file } = current;
    let buffer: AudioBuffer;
    if (file.encoding === 'synth') {
      played = JSON.stringify(file.synth);
      const samples = synthesizeSound(file.synth ?? {});
      buffer = context.createBuffer(1, Math.max(1, samples.length), SOUND_SYNTH_RATE);
      buffer.copyToChannel(samples, 0);
    } else {
      const root = session.project.value?.contentUrl;
      if (root === null || root === undefined) return;
      const response = await fetch(`/${root}${path}.${file.encoding}`);
      buffer = await context.decodeAudioData(await response.arrayBuffer());
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    source.onended = () => voice === source && (voice = undefined);
    voice = source;
  };

  const setSynth = (synth: SoundSynth) => {
    session.editInspected(['synth'], synth);
    void play();
  };

  // 同一个声音的参数在字段里改了：停一下没再改就放一遍
  watch(() => {
    const current = sound();
    return current?.file.encoding === 'synth' ? { path: current.path, synth: JSON.stringify(current.file.synth) } : undefined;
  }, (now, before) => {
    clearTimeout(autoPlay);
    if (now && before?.path === now.path && now.synth !== played) autoPlay = setTimeout(() => void play(), AUTO_PLAY_DELAY);
  });

  onUnmounted(() => {
    clearTimeout(autoPlay);
    stop();
    void context?.close();
  });

  return () => {
    const current = sound();
    if (!current) return undefined;
    const synth = current.file.encoding === 'synth' ? soundSynth(current.file.synth ?? {}) : undefined;
    const seconds = synth ? lengthOf(synth) : undefined;
    return (
      <div {...css.attrs(styles.box)}>
        <div {...css.attrs(styles.row)}>
          <span {...css.attrs(styles.title)}>{t.sound.title}</span>
          <Button size="sm" variant="soft" tone="neutral" icon={Play} onClick={() => void play()}>{t.sound.play}</Button>
          <Button size="sm" variant="ghost" tone="neutral" icon={Square} onClick={stop}>{t.sound.stop}</Button>
          {seconds !== undefined && <span {...css.attrs(styles.hint)}>{t.sound.length(seconds)}</span>}
        </div>
        {synth ? (
          <>
            <div {...css.attrs(styles.row)} title={t.sound.presetsTitle}>
              {PRESETS.map((preset) => (
                <Button size="sm" variant="soft" tone="neutral" {...(preset === 'random' ? { icon: Dices } : {})}
                  onClick={() => setSynth(SOUND_PRESETS[preset](seededRandom(Math.floor(Math.random() * 0x7fffffff))))}>{t.sound.presets[preset]}</Button>
              ))}
            </div>
            <div {...css.attrs(styles.row)}>
              <Button size="sm" variant="soft" tone="neutral" icon={Shuffle} title={t.sound.mutateTitle}
                onClick={() => setSynth(mutateSound(synth, seededRandom(Math.floor(Math.random() * 0x7fffffff))))}>{t.sound.mutate}</Button>
            </div>
          </>
        ) : <span {...css.attrs(styles.hint)}>{t.sound.fileSound}</span>}
      </div>
    );
  };
});
