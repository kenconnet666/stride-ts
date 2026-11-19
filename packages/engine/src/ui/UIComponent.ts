/**
 * UI 组件（Stride 的 UIComponent）：在这个实体上显示一个 UI 页面。全屏时（默认）页面按虚拟分辨率布局、铺满画面，
 * 画在场景之后；不是全屏时放在 3D 场景里，中心在实体的位置（见 UISystem、UIProjection）。脚本里改 page、resolution 立刻生效（GameMenu 的 UISceneBase 把分辨率设成窗口大小）。
 */
import { prop } from '../data/prop';
import { StartupScript } from '../engine/scripts';

export type ResolutionStretch = 'fixedWidthFixedHeight' | 'fixedWidthAdaptableHeight' | 'fixedHeightAdaptableWidth';

export class UIComponent extends StartupScript.props('UIComponent', {
  page: prop.asset('uiPage').optional(),
  /** 虚拟分辨率（宽、高、深度）：页面按它布局。 */
  resolution: prop.vec3().default([1280, 720, 1000]),
  /** 不是全屏时在场景里的大小（世界单位，虚拟分辨率整个铺满它）。 */
  size: prop.vec3().default([1.28, 0.72, 1]),
  /** 虚拟分辨率怎么适应画面的宽高比：宽高都固定（拉伸），固定宽、高按比例，固定高、宽按比例。 */
  resolutionStretch: prop.enum(['fixedWidthFixedHeight', 'fixedWidthAdaptableHeight', 'fixedHeightAdaptableWidth']).default('fixedWidthAdaptableHeight'),
  isFullScreen: prop.bool().default(true),
  /** 不是全屏时总是正对相机。 */
  isBillboard: prop.bool().default(true),
  /** 不是全屏时在画面上的大小不随距离变：Size 的高 1 是画面的高。 */
  isFixedSize: prop.bool().default(false),
  /** 全屏时文字对齐到像素（Stride 的 SnapText）。 */
  snapText: prop.bool().default(true),
  sampler: prop.enum(['linearClamp', 'pointClamp', 'anisotropicClamp']).default('linearClamp'),
}) {
  static override scriptName = 'UIComponent';

  override start(): void {
    this.game.ui.add(this);
    this.disposables.defer(() => this.game.ui.remove(this));
  }
}
