// 游戏：照片比对的场景（路线图 R 组）。地址里的 ?scene= 选哪个场景，默认地铁站台 Subway（scripts/build-subway.ts 搭的）。
import { Game } from '@stride-ts/engine';

export class PhotorealGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene(new URLSearchParams(location.search).get('scene') ?? 'Subway');
  }
}
