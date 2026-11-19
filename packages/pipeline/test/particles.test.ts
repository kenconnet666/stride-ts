import { describe, expect, test } from 'vitest';
import { importParticleSystem } from '../src/stride/particles.ts';
import { asObject, parseStrideYaml } from '../src/stride/yaml.ts';

const COMPONENT = `
Component: !ParticleSystemComponent
    Id: a683292a-e2c3-4247-af8a-6cc3b4c535a7
    Control:
        ResetSeconds: 5.0
        Control: Play
    Color: {R: 1.0, G: 1.0, B: 1.0, A: 1.0}
    Speed: 5.0
    ParticleSystem:
        Settings: {}
        Emitters:
            6397977f9dff5e498be808d87893992c:
                EmitterName: Sparks
                ParticleLifetime: {X: 3.0, Y: 5.0}
                ShapeBuilder: !ShapeBuilderCustom
                    Dummy: 1
                Material: !ParticleMaterialComputeColor
                    ComputeColor: !ComputeTextureColor
                        Texture: 8b03c447-e775-437b-a178-b7c0921ebf24:hit_effect
                    UVBuilder: !UVBuilderFlipbook
                        XDivisions: 5
                Spawners:
                    34bb92648ec072409d8d7d9908a20023: !SpawnerPerSecond
                        LoopCondition: OneShot
                        Duration: {X: 0.2, Y: 0.2}
                Initializers:
                    1b69e5edd8a0614c87724fee7903d49f: !Initial3DRotationSeed
                        DisplayParticleRotation: true
                        RotationQuaternionMin: {X: 0.0, Y: 0.0, Z: 0.0, W: 1.0}
                    2b69e5edd8a0614c87724fee7903d49f: !InitialUnknownSeed
                        Dummy: 1
                    3b69e5edd8a0614c87724fee7903d49f: !InitialPositionArc
                        Target: ref!! e574779f-f5b0-4272-8b43-f67704512191
                    4b69e5edd8a0614c87724fee7903d49f: !InitialPositionArc
                        Target: ref!! 00000000-f5b0-4272-8b43-f67704512191
                Updaters: {}
`;

describe('粒子系统的导入', () => {
  test('类型、属性名首字母小写，向量换成数组，集合换成数组，贴图导出，引用换成实体，不认识的模块警告并去掉', async () => {
    const component = asObject(parseStrideYaml(COMPONENT)['Component'])!;
    const warnings: string[] = [];
    const textures: string[] = [];
    const file = await importParticleSystem(component, 'scene', {
      texture: async (id) => {
        textures.push(id);
        return { texture: 'Shared/hit_effect', srgb: true };
      },
      entity: (id) => (id === 'e574779f-f5b0-4272-8b43-f67704512191' ? 'laser-target' : undefined),
      warn: (message) => warnings.push(message),
    });
    expect(file).toEqual({
      control: { resetSeconds: 5, control: 'play' },
      color: [1, 1, 1, 1],
      speed: 5,
      particleSystem: {
        settings: {},
        emitters: [{
          emitterName: 'Sparks',
          particleLifetime: [3, 5],
          shapeBuilder: null,
          material: {
            $type: 'particleMaterialComputeColor',
            computeColor: { $type: 'computeTextureColor', texture: { texture: 'Shared/hit_effect', srgb: true } },
            uvBuilder: { $type: 'uvBuilderFlipbook', xDivisions: 5 },
          },
          spawners: [{ $type: 'spawnerPerSecond', loopCondition: 'oneShot', duration: [0.2, 0.2] }],
          initializers: [
            { $type: 'initial3DRotationSeed', rotationQuaternionMin: [0, 0, 0, 1] },
            { $type: 'initialPositionArc', target: { $entity: 'laser-target' } },
            { $type: 'initialPositionArc', target: null },
          ],
          updaters: [],
        }],
      },
    });
    expect(textures).toEqual(['8b03c447-e775-437b-a178-b7c0921ebf24']);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('ShapeBuilderCustom');
    expect(warnings[1]).toContain('InitialUnknownSeed');
    expect(warnings[2]).toContain('00000000-f5b0-4272-8b43-f67704512191 is not in this scene');
  });
});
