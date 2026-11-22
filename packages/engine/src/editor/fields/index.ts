/**
 * 属性面板要的字段描述：场景文件里一个实体的每种组件有哪些字段、各是什么（数、向量、颜色、枚举、资源、实体……）、范围、
 * 单位、没写时的值。面板照着它画控件、生成对场景文档的修改；`checkFields` 照着它检查一个值（保存前、读别人写的文件时）。
 *
 * 两个来源，同一个形状（Field）：
 * - 引擎的组件（components 的各个键）：这个文件里手写的 COMPONENT_FIELDS。用 `fields<T>()` 写，文件格式的类型里有的字段
 *   这里必须都有、多一个少一个都过不了类型检查，所以格式加了字段，面板不会悄悄漏掉；
 * - 游戏的脚本：`scriptFields` 从脚本类的 `prop` 声明换过来。
 *
 * 只是数据，不依赖 DOM 和运行着的游戏（scriptFields 要脚本的类，在游戏页面里调）。
 */
// 字段描述的构造函数：工程的编辑器扩展给自定义资源写字段时用
export { asset, bool, entity, fields, integer, list, nullable, number, object, oneOf, optional, rotation, string, textureRef, vector, type Field, type FieldSpec, type FieldType } from './builders.ts';
export * from './components.ts';
export * from './assets.ts';
export * from './scripts.ts';
export * from './check.ts';
