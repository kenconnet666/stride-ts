export {
  prop,
  Prop,
  type AssetTypes,
  type Branded,
  type ColorInput,
  type ColumnKind,
  type Columns,
  type DataShape,
  type DataValues,
  type DecimalInput,
  type EntityId,
  type InheritedOf,
  type InitOf,
  type Modifier,
  type PropKind,
  type QuatInput,
  type ScriptValues,
  type Shape,
  type StandardSchema,
  type Vec3Input,
} from './data/prop';
export type { Issue } from './data/schema';
export {
  AnimationComponent,
  PlayingAnimation,
  type AddAnimationOptions,
  type AnimationBlendOperation,
  type AnimationBlendStack,
  type BlendTreeBuilder,
} from './animation/AnimationComponent';
export { AnimationSystem, ModelMorph, ModelSkeleton, type SkinnedPart } from './animation/AnimationSystem';
export { evaluateMorphCurve, ModelMorphs, Morphed, MorphStack } from './animation/morphs';
export { ModelNodeLink } from './animation/ModelNodeLink';
export { AnimationClip, Skeleton, type AnimationNative } from './animation/resources';
export { evaluateCurve, propertyCurve, PropertyAnimated, PropertyStack, type AnimatableKey, type CurveInterpolation, type KeyValue, type PropertyCurve } from './animation/curves';
export { Prefab } from './content/Prefab';
export { SceneTemplate } from './content/SceneTemplate';
export { ContentManager, type CompositorSettings, type ContentOptions, type TextureCamera, type ContentReader, type GameSettings, type LoadedModel, type LoadSceneOptions, type MeshoptDecoder, type MeshoptRequest, type SceneInstance, type SceneReference } from './content/ContentManager';
export type { SceneScriptMap } from './content/sceneScripts';
export {
  decodeCubemap,
  decodeModel,
  encodeCubemap,
  encodeModel,
  FLOAT_LAYOUT,
  IDENTITY_DEQUANTIZE,
  plainMesh,
  vertexLayoutOffsets,
  VERTEX_FLOATS,
  CUBEMAP_TEXEL_BYTES,
  type ColorOperator,
  type CubemapData,
  type CubemapFormat,
  type Dequantize,
  type MeshCompression,
  type VertexLayout,
  type MaterialFile,
  type ModelData,
  type ModelMeshData,
  type AnimationRepeatMode,
  type ColliderShapeFile,
  type SceneBackground,
  type SceneBody,
  type SceneCharacter,
  type SceneCollidable,
  type SceneEntityFile,
  type PrefabFile,
  type SceneFile,
  type SceneCompositor,
  type SceneForwardRenderer,
  type SceneRenderTexture,
  type SceneNavigation,
  type SceneSprite,
  type SceneSpriteFromSheet,
  type SceneSpriteFromTexture,
  type SceneSpriteSettings,
  type SpriteSheetFile,
  type SceneUI,
  type UIElementFile,
  type UIElementType,
  type UIFile,
  type UISpriteValue,
  type UIStripDefinition,
  type UIValue,
  type SceneTextureCamera,
  type SpriteBlend,
  type ScenePhysics,
  type SkyboxFile,
  TEXTURE_EXTENSIONS,
  type TextureEncoding,
  type TextureRef,
  type TextureSlot,
  type ParticleModuleFile,
  type ParticleValue,
  parseCollisionMask,
} from './content/format';
export { Commands } from './engine/Commands';
export {
  component,
  tag,
  ComponentType,
  type BareComponent,
  type ColumnsOf,
  type ComponentInit,
  type ComponentOptions,
  type ExternalStorage,
  type ViewOf,
} from './engine/component';
export { ScopedDefaults } from './engine/defaults';
export type { CloneHandler } from './engine/clone';
export { Entity, type EntityScene, type View } from './engine/Entity';
export { EntityManager, type EntityArg, type EntityDesc, type SpawnBatch } from './engine/EntityManager';
export { EventKey, EventReceiver, Hook, hook, type HookEvent, type HookHandler } from './engine/events';
export { Registry, type HotChange, type Registered } from './engine/registry';
export {
  AsyncScript,
  ScriptComponent,
  StartupScript,
  SyncScript,
  type ScriptConstructor,
  type ScriptInit,
  type ScriptOptions,
  type StatsOf,
} from './engine/scripts';
export { Stat, type StatModifierOptions } from './engine/stats';
export { system, System, type Chunk, type EntityIds, type Phase, type SystemSpec } from './engine/system';
export { Transform, transformSlot, type TransformColumns, type TransformShape, type TransformView } from './engine/transform';
export { validator } from './engine/validator';
export { Debug, FrameTimings, describe, type DebugHandler } from './debug/Debug';
export { DebugText, type DebugTextLine } from './debug/DebugText';
export type { CommandInfo, LogEntry, LogLevel } from './debug/protocol';
export { Game, type GameOptions, type GameStatus, type LoadChildSceneOptions, type LoadGameSettingsOptions, type HotContext } from './games/Game';
export { GameTime } from './games/GameTime';
export { GraphicsDevice } from './graphics/GraphicsDevice';
export { GpuProfiler, type GpuTiming } from './graphics/GpuProfiler';
export { GamePadButton, InputManager, type GamePadState, type InputDevice, type MouseButton, type PointerEvent } from './input/InputManager';
export { VirtualButton, VirtualButtonBinding, VirtualButtonConfig, type VirtualButtonInput } from './input/virtualButtons';
export { InputCapturePriority } from './input/capture';
export { keyCode } from './input/keys';
export { Matrix, type Matrix4 } from './mathematics/Matrix';
export { Collider, hullPoints, type ColliderId, type ColliderShape, type HullTransform } from './physics/Collider';
export { Body, Character, Static } from './physics/components';
export {
  AngularAxisGearMotorConstraintComponent, BallSocketConstraintComponent, BallSocketMotorConstraintComponent, ConstraintComponentBase, DistanceLimitConstraintComponent,
  HingeConstraintComponent, LinearAxisLimitConstraintComponent, OneBodyAngularMotorConstraintComponent, OneBodyAngularServoConstraintComponent,
  OneBodyLinearServoConstraintComponent, PointOnLineConstraintComponent, SwingLimitConstraintComponent, TwistLimitConstraintComponent, WeldConstraintComponent,
} from './physics/ConstraintComponent';
export { BodyControl, Simulation, type Constraint, type ConstraintSettings, type ConstraintSettingsOf, type OverlapShape, type SimulationHit, type SimulationSettings } from './physics/Simulation';
export { DEFAULT_NAVIGATION_SETTINGS, NavigationSystem, type NavigationSettings } from './navigation/NavigationSystem';
export { RecastNavigationComponent, type NavigationState } from './navigation/RecastNavigationComponent';
export { TriggerHandler, type Contact, type ContactHandler, type TouchingContact } from './physics/contacts';
export { Background, Camera, Instance, Instancing, Light, Model, ModelPart, Skinned, Sprite } from './rendering/components';
export { cameraProjectionMatrix, screenToWorldRaySegment, worldToScreen, type CameraProjection } from './rendering/cameraRays';
export { SpriteRenderFeature, spriteQuad, type SpriteShape } from './rendering/SpriteRenderFeature';
export { BackgroundRenderFeature, coverSource } from './rendering/BackgroundRenderFeature';
export { GpuResources } from './rendering/GpuResources';
export { Cubemap, Skybox, type CubemapId, type SkyboxId } from './rendering/Skybox';
export { Bloom } from './rendering/postfx/Bloom';
export { BrightFilter } from './rendering/postfx/BrightFilter';
export { Fxaa, type FxaaDither } from './rendering/postfx/Fxaa';
export { LensFlare } from './rendering/postfx/LensFlare';
export { LightStreak } from './rendering/postfx/LightStreak';
export { gaussianOffsetsWeights } from './rendering/postfx/GaussianBlur';
export { PostProcessingEffects } from './rendering/postfx/PostProcessingEffects';
export { ToneMap } from './rendering/postfx/ToneMap';
export { ForwardRenderer, spotAngleAttenuation } from './rendering/ForwardRenderer';
export {
  Material,
  type MaterialAmbientOcclusion,
  type MaterialDesc,
  type MaterialId,
  type MaterialNormalMap,
  type MaterialTexture,
  type MaterialTransparency,
} from './rendering/Material';
export { SpriteSheet, type SpriteFrame, type SpriteSheetId } from './rendering/SpriteSheet';
export { SpriteFont, type FontGlyph, type LoadedGlyphBlock } from './rendering/text/SpriteFont';
export { SpriteBatch, type Color, type DrawOptions, type DrawStringOptions, type Rect, type Vec2 } from './rendering/text/SpriteBatch';
export { spriteEffect, SPRITE_EFFECT_PARAMETERS, type SpriteEffect } from './rendering/text/SpriteEffect';
export { GlyphStore } from './rendering/text/GlyphStore';
export { glyphAdvance, glyphScale, layoutText, measureText, type FontSize, type PositionedGlyph, type TextAlignment } from './rendering/text/layout';
export {
  UIElement, multiply as multiplyMatrix2D, translation as translationMatrix2D,
  type HorizontalAlignment, type LayoutingContext, type Matrix2D, type Thickness, type VerticalAlignment, type Visibility,
} from './ui/UIElement';
export { Panel, UIElementCollection } from './ui/panels/Panel';
export { Canvas } from './ui/panels/Canvas';
export { GridBase, UniformGrid } from './ui/panels/UniformGrid';
export { Grid, StripDefinition, StripDefinitionCollection, type StripType } from './ui/panels/Grid';
export { StackPanel } from './ui/panels/StackPanel';
export { Control, ContentControl, ContentDecorator } from './ui/controls/ContentControl';
export { Border } from './ui/controls/Border';
export { Button, ButtonBase, type ClickMode } from './ui/controls/Button';
export { Slider } from './ui/controls/Slider';
export { ImageElement, imageSize, type StretchDirection, type StretchType } from './ui/controls/ImageElement';
export { TextBlock } from './ui/controls/TextBlock';
export { ModalElement } from './ui/controls/ModalElement';
export { ScrollBar, ScrollViewer, type Orientation, type ScrollInfo, type ScrollingMode } from './ui/controls/ScrollViewer';
export { EditText, type EditTextInputType } from './ui/controls/EditText';
export { SpriteFromSheet, SpriteFromTexture, type SpriteProvider } from './ui/sprites';
export { buildElement, UILibrary, UIPage, type UIResources } from './ui/UIPage';
export { UIComponent, type ResolutionStretch } from './ui/UIComponent';
export { UIElementLink } from './ui/UIElementLink';
export { AudioEngine } from './audio/AudioEngine';
export { AudioEmitterComponent, AudioEmitterSoundController, AudioListenerComponent } from './audio/AudioEmitterComponent';
export { Sound, SoundInstance, type PlayState } from './audio/Sound';
export { ParticleSystem } from './particles/ParticleSystem';
export { ParticleEmitter, type SimulationSpace, type RandomSeedMethod, type SortingPolicy } from './particles/ParticleEmitter';
export { ParticleSystemComponent, ParticleSystems } from './particles/ParticleSystemComponent';
// 游戏自己的粒子模块（继承这几个基类、导出，场景里按类名找到）用到的
export {
  forEachSpawned, ParticleInitializer, ParticleModule, ParticleSpawner, ParticleTransform, value as particleModuleValue,
  type ParticleContext, type ParticleModuleKind, type SpawnedRange, type SpawnTarget,
} from './particles/modules';
export { ParticleUpdater } from './particles/updaters';
export { ParticleShapeBuilder, VertexWriter, type CameraAxes } from './particles/shapes';
export { MaterialCompiler, ParticleMaterial, type MaterialContext, type MaterialProgram, type UVFrame, type UVFrames } from './particles/material';
export { shaderClass, type ShaderClass } from './rendering/shaderClass';
export { meshEffect, MESH_EFFECT_PARAMETERS, type MeshEffect } from './rendering/meshEffect';
export { particleField, ParticlePool, type AnyParticleField, type CustomParticleField, type ParticleField } from './particles/ParticlePool';
export { RandomOffset, seedFloat } from './particles/random';
export { UISystem } from './ui/UISystem';
export { Mesh, type Bounds, type MeshData, type MeshId } from './rendering/Mesh';
export { browserImageDecoder, ktx2Decoder, Texture, type ImageDecodeOptions, type ImageDecoder, type TextureData, type TextureDecoder, type TextureId } from './rendering/Texture';
export { MipmapGenerator } from './rendering/MipmapGenerator';
export { MeshRenderFeature, type MeshBatch } from './rendering/MeshRenderFeature';
export {
  MAX_DIRECTIONAL_LIGHTS, MAX_LOCAL_LIGHTS, RenderStage, RenderSystem, RenderView, RootRenderFeature, type DirectionalLight, type DirectionalShadowSettings, type Lighting, type RenderContext, type RenderOutput, type ShadowMapFilter,
  type LocalLight, type SceneRenderer, type ShadowMapSize, type ShadowReceiver, type ShadowStabilization, type SkyboxLight, type Viewport,
} from './rendering/RenderSystem';
export { DirectionalShadowCascades, type CascadeRectangle } from './rendering/shadows/DirectionalShadowCascades';
export { ShadowMapRenderer } from './rendering/shadows/ShadowMapRenderer';
export { Color4, Quaternion, srgbToLinear, Vector3, type ColorLike, type QuatLike, type Vec3Like } from './mathematics/vectors';
export { formatBool, formatColor, formatFloat, formatVector } from './mathematics/format';
export { Decimal, type Rounding } from './values/Decimal';
export { civilFromDays, daysFromCivil, Instant, LocalDate, LocalDateTime, LocalTime } from './values/temporal';
export {
  decodeBase64,
  encodeBase64,
  fromWire,
  parseWire,
  parseWireJson,
  stringifyWire,
  toWire,
  wireText,
  wireTypeOf,
  type Json,
  type WireReader,
  type WireType,
} from './values/wire';
