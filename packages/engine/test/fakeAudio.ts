/** 测试用的假 Web Audio（声音、发射器、声音事件的单测共用）。 */
/** 只够 SoundInstance 和发射器用的假 AudioContext：时间手动走，记下开始的播放节点和建出来的空间化节点。 */
export class FakeContext extends EventTarget {
  currentTime = 0;
  state: AudioContextState = 'suspended';
  readonly sampleRate = 1000;
  readonly destination = node();
  readonly started: { offset: number; node: ReturnType<FakeContext['createBufferSource']> }[] = [];
  readonly panners: ReturnType<typeof fakePanner>[] = [];
  readonly convolvers: ReturnType<typeof fakeConvolver>[] = [];
  readonly listener = { positionX: param(), positionY: param(), positionZ: param(), forwardX: param(), forwardY: param(), forwardZ: param(), upX: param(), upY: param(), upZ: param() };

  createGain() { return node({ gain: { value: 1 } }); }
  createStereoPanner() { return node({ pan: { value: 0 } }); }
  createBiquadFilter() { return node({ type: '', frequency: { value: 350 } }); }
  createPanner() {
    const panner = fakePanner();
    this.panners.push(panner);
    return panner;
  }
  createConvolver() {
    const convolver = fakeConvolver();
    this.convolvers.push(convolver);
    return convolver;
  }
  createBuffer(_channels: number, length: number) { return { length, getChannelData: () => new Float32Array(length) }; }
  createBufferSource() {
    const source = node({
      buffer: null as unknown, loop: false, playbackRate: { value: 1 }, onended: null as (() => void) | null, stopped: false,
      start: (_when: number, offset: number): void => void this.started.push({ offset, node: source }),
      stop: (): void => { source.stopped = true; },
    });
    return source;
  }
  async resume() {
    this.state = 'running';
    this.dispatchEvent(new Event('statechange'));
  }
  async close() {}
}

/** 假的音频节点：connect 返回目标（能连着写），disconnect 之后 connected 是 false。 */
function node<T extends object>(extra: T = {} as T) {
  const self = { connected: true, connect: <N>(target: N) => target, disconnect: () => void (self.connected = false), ...extra };
  return self;
}

function fakePanner() {
  return node({
    panningModel: '', distanceModel: '', refDistance: 0, rolloffFactor: 1, coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0,
    positionX: param(), positionY: param(), positionZ: param(), orientationX: param(), orientationY: param(), orientationZ: param(),
  });
}

function fakeConvolver() {
  return node({ buffer: null as { length: number } | null });
}

function param() {
  const self = { value: 0, setValueAtTime: (value: number) => void (self.value = value) };
  return self;
}
