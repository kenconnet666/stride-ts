// UIElementLink：UI 元素带着 3D 实体走。三个场景（全屏的 UI、放在 3D 里面向相机的 UI、倾斜的 UI），点跟着走的按钮换下一个；
// 骑士、球（和烟，粒子还没做）挂在 FollowingEntity 下面，它跟着按钮"ElementName"走。场景里的脚本按类名对上 game/ 里的 TS 脚本。
// `?scene=billboarded`、`?scene=tilted` 直接打开另外两个场景。
import { Game } from '@stride-ts/engine';

export const SCENES = {
  fullscreen: 'UIElementLink/Shared/FullScreen',
  billboarded: 'UIElementLink/Shared/BillboardedScreen',
  tilted: 'UIElementLink/Shared/TiltedScreen',
} as const;

export class UIElementLinkGame extends Game {
  protected override async loadContent(): Promise<void> {
    const wanted = new URLSearchParams(location.search).get('scene') as keyof typeof SCENES | null;
    await this.setRootScene(SCENES[wanted ?? 'fullscreen'] ?? SCENES.fullscreen);
  }
}
