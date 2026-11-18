/**
 * 把组件或脚本的属性声明导出成 Standard Schema（https://standardschema.dev）校验器，给编辑器、
 * Node 后端、表单库这些接收 zod / valibot 的地方用；规则全部来自声明，不用再写一遍。
 *
 *   const result = validator(Health)['~standard'].validate({ max: -1 });
 *   // 结果：{ issues: [{ message: '-1 is below the minimum 0', path: ['max'] }] }
 *
 * 只检查，不转换：通过时 value 就是输入。
 */
import type { DataShape, InitOf, StandardSchema } from '../data/prop';
import type { ComponentType } from './component';
import type { ScriptConstructor, ShapeOfScript } from './scripts';

export function validator<S extends DataShape>(type: ComponentType<S, any>): StandardSchema<InitOf<S, 'data'>>;
export function validator<C extends ScriptConstructor>(type: C): StandardSchema<InitOf<ShapeOfScript<C>, 'script'>>;
export function validator(type: ComponentType<any, any> | ScriptConstructor): StandardSchema<unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'stride-ts',
      validate: (value: unknown) => {
        const issues = type.schema.validate(value);
        return issues.length > 0 ? { issues: issues.map((issue) => ({ message: issue.message, path: issue.path })) } : { value };
      },
    },
  };
}
