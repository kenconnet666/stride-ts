/**
 * 成片导出：离线渲染（OfflineRenderer）的画面用 WebCodecs 编成 H.264、录下的声音混好编成 AAC（浏览器不支持时用 Opus），
 * 封装成 MP4（mp4.ts）；或者把每帧存成 PNG（图像序列，交给别的剪辑、调色软件）。
 *
 *   const mp4 = await exportVideo(game, { seconds: 30, fps: 30, width: 1080, height: 1920, samples: 8 });
 *
 * prepare 在开始渲染、第一帧之前调用（比如把过场的时间轴跳回开头）；onProgress 每帧报一次进度。
 */
import type { Game } from '../engine/Game';
import { mixRecording } from '../audio/AudioRecorder';
import { encodePng } from './png';
import { writeMp4, type Mp4AudioTrack, type Mp4Sample } from './mp4';
import { OfflineRenderer, type OfflineRenderOptions, type RenderedFrame } from './OfflineRenderer';

export interface ExportOptions extends OfflineRenderOptions {
  /** 时长（秒）。 */
  readonly seconds: number;
  /** 开始渲染、第一帧之前调用。 */
  readonly prepare?: (() => void | Promise<void>) | undefined;
  /** 每渲染完一帧调用：done 帧中的第几帧、一共几帧。 */
  readonly onProgress?: ((done: number, total: number) => void) | undefined;
}

export interface VideoExportOptions extends ExportOptions {
  /** 视频的码率（比特每秒）；默认按分辨率和帧率估（1080p30 约 12 Mbps）。 */
  readonly bitrate?: number | undefined;
  /** 带声音（录下的声音混成立体声）；没放声音时不写音频轨。默认 true。 */
  readonly audio?: boolean | undefined;
}

/** 常用的输出预设：横屏 1080p、竖屏 9:16（短视频）、方形。 */
export const RENDER_PRESETS = {
  landscape1080: { width: 1920, height: 1080, fps: 30 },
  landscape4k: { width: 3840, height: 2160, fps: 30 },
  vertical1080: { width: 1080, height: 1920, fps: 30 },
  square1080: { width: 1080, height: 1080, fps: 30 },
} as const satisfies Record<string, Pick<OfflineRenderOptions, 'width' | 'height' | 'fps'>>;

export type RenderPreset = keyof typeof RENDER_PRESETS;

const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
/** 编码器里排着的帧超过这么多就等它消化（帧都在显存外的内存里，1080p 一帧 8 MB）。 */
const MAX_QUEUED_FRAMES = 4;

/** 渲染并编成 MP4（H.264，有声音时加 AAC 或 Opus）。 */
export async function exportVideo(game: Game, options: VideoExportOptions): Promise<Uint8Array<ArrayBuffer>> {
  const { width, height, fps } = options;
  if (width % 2 || height % 2) throw new Error(`exportVideo: H.264 needs an even width and height, got ${width}x${height}`);
  const timescale = Math.round(fps * 1000);
  const frameDuration = Math.round(timescale / fps);
  const samples: Mp4Sample[] = [];
  let avcC: Uint8Array | undefined;
  let failure: Error | undefined;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description && !avcC) avcC = bytesOf(description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const index = Math.round((chunk.timestamp * fps) / 1e6);
      samples.push({ data, time: index * frameDuration, duration: frameDuration, keyframe: chunk.type === 'key' });
    },
    error: (error) => {
      failure = error;
    },
  });
  const config: VideoEncoderConfig = {
    codec: avcCodec(width, height, fps),
    width, height, framerate: fps,
    bitrate: options.bitrate ?? Math.round(width * height * fps * 0.2),
    avc: { format: 'avc' },
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`exportVideo: this browser cannot encode ${config.codec} at ${width}x${height}`);
  encoder.configure(config);
  const keyInterval = Math.max(1, Math.round(fps * 2));

  const renderer = await render(game, options, async (frame) => {
    if (failure) throw failure;
    const video = new VideoFrame(frame.rgba, { format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: Math.round((frame.index * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(video, { keyFrame: frame.index % keyInterval === 0 });
    video.close();
    while (encoder.encodeQueueSize > MAX_QUEUED_FRAMES) await new Promise((resolve) => encoder.addEventListener('dequeue', resolve, { once: true }));
  });
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!avcC) throw new Error('exportVideo: the encoder gave no decoder configuration (avcC)');

  const sounds = renderer.audio.sounds;
  const audio = options.audio !== false && sounds.length > 0 ? await encodeAudio(await mixRecording(sounds, options.seconds, AUDIO_SAMPLE_RATE)) : undefined;
  return writeMp4({ video: { width, height, timescale, avcC, samples }, audio });
}

/** 渲染成图像序列：每帧一张 PNG，交给 write（帧号从 0 开始）。 */
export async function exportImages(game: Game, options: ExportOptions, write: (index: number, png: Uint8Array<ArrayBuffer>) => Promise<void>): Promise<void> {
  await render(game, options, async (frame) => write(frame.index, await encodePng(frame.rgba, frame.width, frame.height)));
}

/** 离线渲染 seconds 秒，每帧交给 consume；结束（包括出错）时还原游戏的设置。返回渲染器（录下的声音在它上面）。 */
async function render(game: Game, options: ExportOptions, consume: (frame: RenderedFrame) => Promise<void>): Promise<OfflineRenderer> {
  const renderer = new OfflineRenderer(game, options);
  const total = Math.max(1, Math.round(options.seconds * options.fps));
  await renderer.begin();
  try {
    await options.prepare?.();
    for (let i = 0; i < total; i++) {
      await consume(await renderer.renderFrame());
      options.onProgress?.(i + 1, total);
    }
  } finally {
    renderer.end();
  }
  return renderer;
}

/** 混好的声音编成 AAC-LC（不支持时 Opus）。 */
async function encodeAudio(buffer: AudioBuffer): Promise<Mp4AudioTrack> {
  const base = { sampleRate: AUDIO_SAMPLE_RATE, numberOfChannels: AUDIO_CHANNELS, bitrate: 192_000 };
  const aac = { ...base, codec: 'mp4a.40.2' };
  const codec = (await AudioEncoder.isConfigSupported(aac)).supported ? 'aac' : 'opus';
  const samples: Mp4Sample[] = [];
  let config: Uint8Array | undefined;
  let failure: Error | undefined;
  const encoder = new AudioEncoder({
    output: (chunk, metadata) => {
      const description = metadata?.decoderConfig?.description;
      if (description && !config) config = bytesOf(description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, time: Math.round((chunk.timestamp * AUDIO_SAMPLE_RATE) / 1e6), duration: Math.round(((chunk.duration ?? 0) * AUDIO_SAMPLE_RATE) / 1e6), keyframe: true });
    },
    error: (error) => {
      failure = error;
    },
  });
  encoder.configure(codec === 'aac' ? aac : { ...base, codec: 'opus' });
  // 一次喂 1024 个样本（AAC 一块的长度），平面的 32 位浮点
  const BLOCK = 1024;
  const channels = Array.from({ length: AUDIO_CHANNELS }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
  for (let at = 0; at < buffer.length; at += BLOCK) {
    const frames = Math.min(BLOCK, buffer.length - at);
    const planar = new Float32Array(frames * AUDIO_CHANNELS);
    channels.forEach((data, c) => planar.set(data.subarray(at, at + frames), c * frames));
    const data = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_SAMPLE_RATE, numberOfFrames: frames, numberOfChannels: AUDIO_CHANNELS, timestamp: Math.round((at * 1e6) / AUDIO_SAMPLE_RATE), data: planar });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  return { codec, sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS, ...(config ? { config } : {}), samples };
}

/**
 * H.264 High 档次的 codec 字符串，级别按每秒的宏块数和一帧的宏块数挑够用的最低一级（ITU-T H.264 表 A-1）。
 */
export function avcCodec(width: number, height: number, fps: number): string {
  const frame = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = frame * fps;
  const levels: [number, number, number][] = [[0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3c, 139264, 4177920]];
  const level = levels.find(([, maxFrame, maxRate]) => frame <= maxFrame && rate <= maxRate)?.[0] ?? 0x3c;
  return `avc1.6400${level.toString(16).padStart(2, '0')}`;
}

function bytesOf(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() : new Uint8Array(source).slice();
}
