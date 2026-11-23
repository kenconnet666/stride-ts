// 游戏：照片比对的场景（路线图 R 组）。地址里的 ?scene= 选哪个场景，默认地铁站台 Subway（scripts/build-subway.ts 搭的）。
import { Camera, EditorCameraController, Game } from '@stride-ts/engine';

export class PhotorealGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene(new URLSearchParams(location.search).get('scene') ?? 'Subway');
    // 这些场景没有玩法：主相机挂上编辑器视口那套自由相机（按住右键拖转头、同时 WASD 走、Q/E 上下、Shift 加速，中键平移，
    // 滚轮推拉），不带 ?stride-edit 也能到处看；不动鼠标时相机停在场景定的机位，照片比对的截图不受影响
    if (this.editing) return;
    for (const id of this.entities.ids()) {
      const entity = this.entities.entity(id);
      if (entity.get(Camera)) {
        entity.add({ script: EditorCameraController, init: {} });
        return;
      }
    }
  }
}
