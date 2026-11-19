// CSharpIntermediate 的 AsyncWebApi：按 G 从 Open Collective 的 Web API 取 Stride 最近的几个活动，把名字打印出来。
// 请求是异步的，等的时候游戏照常跑（Stride 用 HttpClient，这里用 fetch）。
// 和 Stride 不同：提示写的是按 G（Stride 的提示写成了 A，判断的却是 G）；请求失败时记一条警告，不让脚本停掉。
import { AsyncScript } from '@stride-ts/engine';

const EVENTS_URL = 'https://opencollective.com/stride3d/events.json?limit=4';

interface OpenCollectiveEvent {
  readonly name: string;
}

export class AsyncWebApi extends AsyncScript {
  #events: readonly OpenCollectiveEvent[] = [];

  override async execute(): Promise<void> {
    for (;;) {
      let y = 600;
      this.game.debugText.print('Press G to get Api data from https://opencollective.com/stride3d', [500, y]);
      if (this.game.input.isKeyPressed('G')) {
        await this.#retrieve();
        await this.nextFrame();
      }
      for (const event of this.#events) this.game.debugText.print(event.name, [500, (y += 20)]);
      await this.nextFrame();
    }
  }

  async #retrieve(): Promise<void> {
    try {
      const response = await fetch(EVENTS_URL, { signal: this.signal });
      if (response.ok) this.#events = (await response.json()) as OpenCollectiveEvent[];
    } catch (error) {
      // 脚本移除时请求被中止：照常往外抛，execute 就此结束
      if (this.signal.aborted) throw error;
      console.warn(`[AsyncWebApi] ${EVENTS_URL}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
