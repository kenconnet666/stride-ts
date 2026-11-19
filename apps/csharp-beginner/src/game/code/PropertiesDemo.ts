// CSharpBeginner 的 PropertiesDemo：各种类型的脚本属性（编辑器里填的值随场景导入），打印出来。
// Stride 的 Vector2、Vector4 在我们这里是数组，Color 是 0 到 255 的字节；[DataMember(4, "My custom text")] 改了名字的 SomeFloat
// 在场景里的键是 "my custom text"。
import { formatBool, formatColor, formatFloat, formatVector, prop, SyncScript, type StandardSchema } from '@stride-ts/engine';

/** 原样收下的 JSON（字典这种没有专门的属性类型的）。 */
const ANY_JSON: StandardSchema<unknown> = { '~standard': { version: 1, vendor: 'stride-ts', validate: (value) => ({ value }) } };
const byte = () => prop.int().default(0);

export class PropertiesDemo extends SyncScript.props({
  someString: prop.string().default('Hello Stride'),
  someInteger: prop.int().default(10),
  someBoolean: prop.bool().default(true),
  someFloat: prop.f32().default(5.6).renamedFrom('my custom text'),
  someVector2: prop.list(prop.f32()).default([0, 0]),
  someVector3: prop.vec3().default([1, 2, 3]),
  someVector4: prop.list(prop.f32()).default([5, 5, 5, 5]),
  someColor: prop.object({ r: byte(), g: byte(), b: byte(), a: byte() }).default({ r: 255, g: 0, b: 0, a: 255 }),
  rangedFloat: prop.f32().default(10).min(1).max(100),
  aSingleEntity: prop.entity().optional(),
  aSingleCameraComponent: prop.entity().optional(),
  stringList: prop.list(prop.string()).default([]),
  entityList: prop.list(prop.entity()).default([]),
  cameraList: prop.list(prop.entity()).default([]),
  aSimpleDictionary: prop.json(ANY_JSON).optional(),
  character: prop.enum(['Warrior', 'Archer', 'Mage']).default('Warrior'),
  explanation: prop.string().optional(),
}) {
  override update(): void {
    const x = 400;
    const [v2x = 0, v2y = 0] = this.someVector2, [v4x = 0, v4y = 0, v4z = 0, v4w = 0] = this.someVector4;
    const { r, g, b, a } = this.someColor;
    const print = (text: string, y: number) => this.game.debugText.print(text, [x, y]);
    print(`Integer: ${this.someInteger}`, 200);
    print(`Float: ${formatFloat(this.someFloat)}`, 220);
    print(`Boolean: ${formatBool(this.someBoolean)}`, 240);
    print(`String: ${this.someString}`, 260);
    print(`Vector2: ${formatVector({ x: v2x, y: v2y })}`, 280);
    print(`Vector3: ${formatVector(this.someVector3)}`, 300);
    print(`Vector4: ${formatVector({ x: v4x, y: v4y, z: v4z, w: v4w })}`, 320);
    print(`Color: ${formatColor([r / 255, g / 255, b / 255, a / 255])}`, 340);
    print(`String list count: ${this.stringList.length}`, 360);
    print(`Entity list count: ${this.entityList.length}`, 380);
    print(`Camera list count: ${this.cameraList.length}`, 400);
  }
}
