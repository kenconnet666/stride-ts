// PhysicsSample：三个物理演示场景（Raycasting、VolumeTrigger、Constraints），场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。
// 从 Raycasting 开始（`?scene=PhysicsSample/VolumeTrigger` 这样换开始的场景），NextSceneScript 在场景之间换。
// 还没有的（P2）：各场景的 UI 文字和按钮（现在用调试命令代替）。
import { Game } from '@stride-ts/engine';

const SCENE = 'PhysicsSample/Raycasting';

export class PhysicsSampleGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene(new URLSearchParams(location.search).get('scene') ?? SCENE);
  }
}
