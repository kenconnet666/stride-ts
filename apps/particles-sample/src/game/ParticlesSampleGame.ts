// ParticlesSample：七个粒子演示场景，场景里的脚本按类名对上 game/ 里翻译过来的 TS 脚本。从 MainScene 开始
// （`?scene=ParticlesSample/Shared/Lasers` 这样换开始的场景），NextSceneScript 在场景之间换。
import { Game } from '@stride-ts/engine';

const SCENE = 'ParticlesSample/Shared/MainScene';

export class ParticlesSampleGame extends Game {
  protected override async loadContent(): Promise<void> {
    await this.setRootScene(new URLSearchParams(location.search).get('scene') ?? SCENE);
  }
}
