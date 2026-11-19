// AnimatedModel：一个跑步的 mannequin，拖动（或移动鼠标）转动它，两盏方向光、2D 背景。
// 场景里的脚本（RotateEntity、UIScript）按类名对上 game/ 里翻译过来的 TS 脚本。
// 还没有的（P2）：UI 页面上的 Idle、Run 按钮（先用调试命令 `stride call idle`、`stride call run` 代替），
// 第二个相机渲染到纹理、两个用这张纹理的精灵。
import { Game } from '@stride-ts/engine';

const SCENE = 'AnimatedModel/Scene';

export class AnimatedModelGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.loadScene(SCENE);
  }
}
