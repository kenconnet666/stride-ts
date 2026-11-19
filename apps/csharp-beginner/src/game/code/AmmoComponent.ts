// CSharpBeginner 的 AmmoComponent：给 GettingAComponentDemo、AddingAComponentDemo 取、加的组件，剩余弹药是 30 - 12。
import { StartupScript } from '@stride-ts/engine';

export class AmmoComponent extends StartupScript {
  readonly #maxBullets = 30;
  readonly #currentBullets = 12;

  getRemainingAmmo(): number {
    return this.#maxBullets - this.#currentBullets;
  }
}
