/**
 * 最小的 MP4（ISO BMFF）封装：一条 H.264 视频轨，可选一条音频轨（AAC 或 Opus），WebCodecs 编出来的块原样放进 mdat，
 * moov 在最后（不分片）。成片导出用（offline/VideoExport.ts）。依赖逐项替代的规矩：封装就这几个盒子，自己写比带一个库省事。
 *
 * 盒子：ftyp、mdat、moov（mvhd、每条轨 trak：tkhd、mdia：mdhd、hdlr、minf：vmhd 或 smhd、dinf、stbl：stsd、stts、ctts（视频有
 * B 帧时）、stss（视频）、stsc、stsz、co64））。参考 ISO/IEC 14496-12、14496-15（avcC）、14496-14（esds）、Opus in ISOBMFF（dOps）。
 */

/** 一个编好的样本（一帧视频或一块音频）。时刻和时长按轨道的 timescale。 */
export interface Mp4Sample {
  readonly data: Uint8Array;
  /** 呈现时刻。 */
  readonly time: number;
  readonly duration: number;
  /** 关键帧（音频的每块都是）。 */
  readonly keyframe: boolean;
}

export interface Mp4VideoTrack {
  readonly width: number;
  readonly height: number;
  readonly timescale: number;
  /** AVCDecoderConfigurationRecord（WebCodecs 的 decoderConfig.description）。 */
  readonly avcC: Uint8Array;
  /** 按解码顺序（编码器输出的顺序）。 */
  readonly samples: readonly Mp4Sample[];
}

export interface Mp4AudioTrack {
  readonly codec: 'aac' | 'opus';
  readonly sampleRate: number;
  readonly channels: number;
  /** AAC：AudioSpecificConfig；Opus：OpusHead（WebCodecs 的 description），没有时按声道数写一个。 */
  readonly config?: Uint8Array;
  readonly samples: readonly Mp4Sample[];
}

export function writeMp4({ video, audio }: { readonly video: Mp4VideoTrack; readonly audio?: Mp4AudioTrack | undefined }): Uint8Array<ArrayBuffer> {
  const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
  // mdat 的内容：先视频的全部样本，再音频的；co64 记每个样本在文件里的位置（每个样本一个块）
  const tracks = [video.samples, audio?.samples ?? []];
  const payload = tracks.flat().reduce((sum, sample) => sum + sample.data.length, 0);
  const mdatHeader = 16; // 64 位大小的盒子头
  let offset = ftyp.length + mdatHeader;
  const offsets = tracks.map((samples) => samples.map((sample) => {
    const at = offset;
    offset += sample.data.length;
    return at;
  }));
  const mdat = new Uint8Array(mdatHeader + payload);
  const view = new DataView(mdat.buffer);
  view.setUint32(0, 1);
  mdat.set(ascii('mdat'), 4);
  view.setBigUint64(8, BigInt(mdat.length));
  let at = mdatHeader;
  for (const sample of tracks.flat()) {
    mdat.set(sample.data, at);
    at += sample.data.length;
  }

  const MOVIE_TIMESCALE = 1000;
  const videoDuration = trackDuration(video.samples);
  const audioDuration = audio ? trackDuration(audio.samples) : 0;
  const movieDuration = Math.max(videoDuration / video.timescale, audio ? audioDuration / audio.sampleRate : 0) * MOVIE_TIMESCALE;
  const traks = [videoTrak(video, offsets[0]!, Math.round((videoDuration / video.timescale) * MOVIE_TIMESCALE))];
  if (audio) traks.push(audioTrak(audio, offsets[1]!, Math.round((audioDuration / audio.sampleRate) * MOVIE_TIMESCALE)));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(Math.round(movieDuration)), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(traks.length + 1));
  const moov = box('moov', mvhd, ...traks);
  return concat(ftyp, mdat, moov);
}

function videoTrak(track: Mp4VideoTrack, offsets: readonly number[], movieDuration: number): Uint8Array {
  const avc1 = box('avc1',
    zeros(6), u16(1), // 保留、数据引用下标
    zeros(16), u16(track.width), u16(track.height),
    u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff),
    box('avcC', track.avcC));
  return trak(1, track.width, track.height, 0, movieDuration, track.timescale, 'vide', 'VideoHandler',
    fullBox('vmhd', 0, 1, zeros(8)), avc1, track.samples, offsets, true);
}

function audioTrak(track: Mp4AudioTrack, offsets: readonly number[], movieDuration: number): Uint8Array {
  const common = [zeros(6), u16(1), zeros(8), u16(track.channels), u16(16), zeros(4), u32(track.sampleRate << 16)];
  const entry = track.codec === 'aac'
    ? box('mp4a', ...common, esds(track.config ?? aacConfig(track.sampleRate, track.channels)))
    : box('Opus', ...common, dOps(track));
  return trak(2, 0, 0, 0x0100, movieDuration, track.sampleRate, 'soun', 'SoundHandler', fullBox('smhd', 0, 0, zeros(4)), entry, track.samples, offsets, false);
}

function trak(
  id: number, width: number, height: number, volume: number, movieDuration: number, timescale: number, handler: string, handlerName: string,
  mediaHeader: Uint8Array, sampleEntry: Uint8Array, samples: readonly Mp4Sample[], offsets: readonly number[], video: boolean,
): Uint8Array {
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(movieDuration), zeros(8), u16(0), u16(0), u16(volume), u16(0), MATRIX, u32(width << 16), u32(height << 16));
  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(trackDuration(samples)), u16(0x55c4), u16(0)); // 语言 und
  const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii(handler), zeros(12), ascii(handlerName), new Uint8Array([0]));
  const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));
  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry),
    stts(samples),
    ...(video ? ctts(samples) : []),
    ...(video ? [stss(samples)] : []),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((sample) => u32(sample.data.length))),
    fullBox('co64', 0, 0, u32(offsets.length), ...offsets.map(u64)));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, stbl)));
}

/** 解码时刻的间隔：按解码顺序每个样本的时长（连着一样的并成一条）。 */
function stts(samples: readonly Mp4Sample[]): Uint8Array {
  const runs: [number, number][] = [];
  for (const { duration } of samples) {
    const last = runs.at(-1);
    if (last && last[1] === duration) last[0]++;
    else runs.push([1, duration]);
  }
  return fullBox('stts', 0, 0, u32(runs.length), ...runs.flatMap(([count, delta]) => [u32(count), u32(delta)]));
}

/**
 * 呈现时刻 − 解码时刻（有 B 帧时不为 0）：解码时刻是按解码顺序累加的时长。全是 0 时不写这个盒子。用版本 1（偏移可以为负）。
 */
function ctts(samples: readonly Mp4Sample[]): Uint8Array[] {
  let decode = 0;
  const shifts = samples.map((sample) => {
    const shift = sample.time - decode;
    decode += sample.duration;
    return shift;
  });
  if (shifts.every((shift) => shift === 0)) return [];
  const runs: [number, number][] = [];
  for (const shift of shifts) {
    const last = runs.at(-1);
    if (last && last[1] === shift) last[0]++;
    else runs.push([1, shift]);
  }
  return [fullBox('ctts', 1, 0, u32(runs.length), ...runs.flatMap(([count, shift]) => [u32(count), i32(shift)]))];
}

function stss(samples: readonly Mp4Sample[]): Uint8Array {
  const keys = samples.flatMap((sample, i) => (sample.keyframe ? [i + 1] : []));
  return fullBox('stss', 0, 0, u32(keys.length), ...keys.map(u32));
}

/** AAC 的 esds：ES 描述符里套解码器配置和 AudioSpecificConfig。 */
function esds(config: Uint8Array): Uint8Array {
  const descriptor = (tag: number, ...parts: Uint8Array[]) => {
    const body = concat(...parts);
    return concat(new Uint8Array([tag, 0x80, 0x80, 0x80, body.length]), body);
  };
  const decoderSpecific = descriptor(0x05, config);
  const decoderConfig = descriptor(0x04, new Uint8Array([0x40, 0x15]), zeros(3), u32(0), u32(0), decoderSpecific);
  const sl = descriptor(0x06, new Uint8Array([0x02]));
  return fullBox('esds', 0, 0, descriptor(0x03, u16(1), new Uint8Array([0]), decoderConfig, sl));
}

/** AAC-LC 的 AudioSpecificConfig（编码器没给时）：对象类型 2、采样率下标、声道数。 */
function aacConfig(sampleRate: number, channels: number): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const index = Math.max(0, rates.indexOf(sampleRate));
  return new Uint8Array([(2 << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3)]);
}

/** Opus 的 dOps：从 OpusHead 抄预跳过、输入采样率、输出增益（编码器没给时按 3840 个样本的预跳过）。 */
function dOps(track: Mp4AudioTrack): Uint8Array {
  const head = track.config;
  const preSkip = head && head.length >= 12 ? head[10]! | (head[11]! << 8) : 3840;
  return box('dOps', new Uint8Array([0, track.channels]), u16(preSkip), u32(track.sampleRate), u16(0), new Uint8Array([0]));
}

function trackDuration(samples: readonly Mp4Sample[]): number {
  return samples.reduce((sum, sample) => sum + sample.duration, 0);
}

const MATRIX = concat(u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000));

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(u32(8 + body.length), ascii(type), body);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(type, new Uint8Array([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function i32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
