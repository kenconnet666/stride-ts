// PhysicsSample 的 GuiScript（Raycasting 场景）：画面下方一行字 "Shoot the cubes!"。
import { Canvas, prop, StartupScript, TextBlock, UIComponent, UIPage } from '@stride-ts/engine';

const WHITE = [1, 1, 1, 1] as const;

export class GuiScript extends StartupScript.props({
  font: prop.asset('font'),
}, { requires: [() => UIComponent] }) {
  override start(): void {
    const text = Object.assign(new TextBlock(), {
      text: 'Shoot the cubes!', font: this.font, textColor: WHITE, textSize: 60,
      canvasPinOrigin: [0.5, 0.5] as const, canvasRelativePosition: [0.5, 0.9] as const,
    });
    const root = new Canvas();
    root.children.add(text);
    this.entity.require(UIComponent).page = new UIPage('Gui', root);
  }
}
