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
export { evaluateCurve, propertyCurve, PropertyAnimated, PropertyStack, writeCurveValue, type AnimatableKey, type CurveInterpolation, type KeyValue, type PropertyCurve } from './animation/curves';
export { Timeline, type TimelineBinding, type TimelineCue, type TimelineState } from './animation/Timeline';
export { TimelinePlayer } from './animation/TimelinePlayer';
export { Prefab, type EntityShape, type PrefabShape, type SpawnedEntity, type SpawnedPrefab, type UntypedEntityShape, type UntypedPrefabShape } from './content/Prefab';
export { SceneTemplate } from './content/SceneTemplate';
export { assetRef, ContentManager, type AssetHandle, type LoadedAsset, type CompositorSettings, type ContentOptions, type TextureCamera, type ContentReader, type GameSettings, type LoadedModel, type LoadSceneOptions, type MeshoptDecoder, type MeshoptRequest, type SceneInstance, type SceneReference } from './content/ContentManager';
export type { SceneScriptMap } from './content/sceneScripts';
export {
  decodeCubemap,
  decodeModel,
  generateProceduralMesh,
  isProceduralModel,
  parseProceduralModel,
  PROCEDURAL_MODEL_FORMAT,
  PROCEDURAL_SHAPES,
  proceduralModelData,
  proceduralTangents,
  readModelFile,
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
  type ProceduralMesh,
  type ProceduralModel,
  type ProceduralModelFile,
  type ProceduralShape,
  type ModelMeshData,
  type AnimationRepeatMode,
  type ColliderShapeFile,
  type SceneBackground,
  type SceneReflectionProbe,
  type SceneIrradianceVolume,
  type SceneDayNightCycle,
  type SceneSkyAtmosphere,
  type SceneVolumetricClouds,
  type SceneVolumetricFog,
  type SceneWeather,
  type SceneDecal,
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
  CEL_BLACK_AND_WHITE_RAMP,
  CEL_DEFAULT_RAMP,
  CEL_RAMP_STOPS,
  type CelRamp,
  type CelShading,
  type MicrofacetModel,
} from './content/formats/format';
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
  type RequiredComponent,
  type ScriptConstructor,
  type ScriptInit,
  type ScriptOptions,
  type StatsOf,
} from './engine/scripts';
export { Stat, type StatModifierOptions } from './engine/stats';
export { system, System, type Chunk, type EntityIds, type Phase, type SystemSpec } from './engine/system';
export { entityAtSlot, SceneRoot, Transform, transformSlot, type TransformColumns, type TransformShape, type TransformView } from './engine/transform';
export { validator } from './engine/validator';
export { Debug, FrameTimings, describe, type DebugHandler } from './debug/Debug';
export { DebugText, type DebugTextLine } from './debug/DebugText';
export { drawCollider } from './physics/debugShapes';
export { ScenePicker } from './rendering/ScenePicker';
export { EditorCameraController, EditorCameraState } from './editor/viewport/EditorCamera';
export type { EditableScene, EditAgent, PaintBrush, PaintSession, SculptBrush, SculptSession, RequiredComponentEntry, WorldSphere } from './editor/viewport/EditAgent';
export type { PolyEditSession, PolySelection, PolySelectMode } from './editor/viewport/PolyEditTool';
export { branchFromPoint, deleteSplinePoints, type SplineEditSession } from './editor/viewport/SplineEditTool';
export { deleteBrush, type BrushEditSession } from './editor/viewport/BrushEditTool';
export { applyGizmoChange, applySnap, DEFAULT_SNAP, TransformGizmo, type GizmoAxis, type GizmoChange, type GizmoHandle, type GizmoMode, type SnapSettings } from './editor/viewport/TransformGizmo';
export { checkEntity, checkFields, COMPONENT_FIELDS, ENTITY_FIELDS, scriptFields, TEXTURE_FIELDS, type ComponentDescription, type Field, type FieldType } from './editor/fields/index';
export { LiveScene, type SceneSource } from './editor/LiveScene';
export { Metrics, type Metric, type MetricUnit } from './debug/Metrics';
export { limitShadowCascades, limitShadowFilter, limitShadowSize, QUALITY_TIERS, type QualitySettings, type QualityTier } from './rendering/Quality';
export { GpuMemory, PipelineCounts, textureBytes, type GpuResourceCount } from './graphics/GpuMemory';
export type { ModelUse } from './content/SceneBuilder';
export { SceneDocument, UndoStack, type EntitiesFile, type SceneEdit, type ScenePath } from './editor/SceneDocument';
export { changedEntities, type EntityChanges } from './content/SceneBuilder';
export { assetReferences, assetReferenceSlots, entityAssetReferences, type AssetKind, type AssetReference, type AssetReferenceSlot, type EntityAssetReference } from './content/references';
export { DebugDraw, DEBUG_LINE_FLOATS, type DebugColor, type DebugDrawOptions, type DebugPoint } from './debug/DebugDraw';
export type { CommandInfo, LogEntry, LogLevel } from './debug/protocol';
export { Game, type GameOptions, type GameStatus, type LoadChildSceneOptions, type LoadGameSettingsOptions, type HotContext } from './engine/Game';
export { GameTime } from './engine/GameTime';
export { UserPreferences } from './engine/UserPreferences';
export { GraphicsDevice } from './graphics/GraphicsDevice';
export { GpuProfiler, type GpuTiming } from './graphics/GpuProfiler';
export { GamePadButton, InputManager, type GamePadState, type InputDevice, type MouseButton, type PointerEvent } from './input/InputManager';
export { VirtualButton, VirtualButtonBinding, VirtualButtonConfig, type VirtualButtonInput } from './input/virtualButtons';
export {
  createGestureRecognizer, GestureCollection, GestureRecognizer, Gestures,
  type CompositeConfig, type CompositeEvent, type DragConfig, type DragEvent, type FlickConfig, type FlickEvent, type GestureConfig, type GestureEvent, type GestureShape,
  type GestureState, type LongPressConfig, type LongPressEvent, type TapConfig, type TapEvent,
} from './input/gestures';
export { InputCapturePriority } from './input/capture';
export { keyCode } from './input/keys';
export { Matrix, type Matrix4 } from './data/Matrix';
export { Collider, hullPoints, type ColliderId, type ColliderShape, type HullTransform } from './physics/Collider';
export { Body, Character, Static } from './physics/components';
export {
  AngularAxisGearMotorConstraintComponent, BallSocketConstraintComponent, BallSocketMotorConstraintComponent, ConstraintComponentBase, DistanceLimitConstraintComponent,
  HingeConstraintComponent, LinearAxisLimitConstraintComponent, OneBodyAngularMotorConstraintComponent, OneBodyAngularServoConstraintComponent,
  OneBodyLinearServoConstraintComponent, PointOnLineConstraintComponent, SwingLimitConstraintComponent, TwistLimitConstraintComponent, WeldConstraintComponent,
} from './physics/ConstraintComponent';
export { BodyControl, Simulation, type Constraint, type ConstraintSettings, type ConstraintSettingsOf, type OverlapShape, type SimulationHit, type SimulationSettings } from './physics/Simulation';
export { DEFAULT_NAVIGATION_SETTINGS, NavigationSystem, type NavigationSettings } from './physics/NavigationSystem';
export { RecastNavigationComponent, type NavigationState } from './physics/RecastNavigationComponent';
export { TriggerHandler, type Contact, type ContactHandler, type TouchingContact } from './physics/contacts';
export { CameraRig, cameraRigSystem } from './rendering/CameraRig';
export { Background, Camera, GaussianSplat, Instance, Instancing, IrradianceVolume, Light, Model, ModelPart, PlanarReflection, ReflectionProbe, Skinned, SkyAtmosphere, Sprite, VolumetricClouds, VolumetricFog, Decal } from './rendering/components';
export { Decals, packDecal, tileSize, type AtlasRect, type DecalInstance } from './rendering/mesh/Decals';
export { packPages } from './data/rectPacking';
export { Fog, type FogSettings } from './rendering/sky/VolumetricFog';
export { Clouds, type CloudSettings } from './rendering/sky/VolumetricClouds';
export { Atmosphere, DynamicSky, EARTH_ATMOSPHERE, sunTransmittance, type AtmosphereSettings, type CelestialBody } from './rendering/sky/Atmosphere';
export { celestialState, DayNightCycle, lightRotationTowards, type CelestialState } from './rendering/sky/DayNightCycle';
export { AtmosphereRenderFeature } from './rendering/sky/AtmosphereRenderFeature';
export { MAX_REFLECTION_PROBES, ReflectionProbes } from './rendering/lighting/ReflectionProbes';
export { cameraProjectionMatrix, screenToWorldRaySegment, worldToScreen, type CameraProjection } from './rendering/cameraRays';
export { SpriteRenderFeature, spriteQuad, type SpriteShape } from './rendering/SpriteRenderFeature';
export { BackgroundRenderFeature, coverSource } from './rendering/sky/BackgroundRenderFeature';
export { GpuResources } from './graphics/GpuResources';
export { Cubemap, Skybox, type CubemapId, type SkyboxId } from './rendering/lighting/Skybox';
export { Bloom } from './rendering/postfx/Bloom';
export { BrightFilter } from './rendering/postfx/BrightFilter';
export { Fxaa, type FxaaDither } from './rendering/postfx/Fxaa';
export { LensFlare } from './rendering/postfx/LensFlare';
export { LightStreak } from './rendering/postfx/LightStreak';
export { gaussianOffsetsWeights } from './rendering/postfx/GaussianBlur';
export { PostProcessingEffects } from './rendering/postfx/PostProcessingEffects';
export { ToneMap } from './rendering/postfx/tonemap/ToneMap';
export { ForwardRenderer, spotAngleAttenuation } from './rendering/ForwardRenderer';
export {
  Material,
  type MaterialAmbientOcclusion,
  type MaterialDesc,
  type MaterialId,
  type MaterialNormalMap,
  type MaterialTexture,
  type MaterialTransparency,
} from './rendering/mesh/Material';
export { SpriteSheet, type SpriteFrame, type SpriteSheetId } from './rendering/SpriteSheet';
export { SpriteFont, type FontGlyph, type LoadedGlyphBlock } from './rendering/text/SpriteFont';
export { SpriteBatch, type Color, type DrawOptions, type DrawRichTextOptions, type DrawStringOptions, type Rect, type Vec2 } from './rendering/text/SpriteBatch';
export { spriteEffect, SPRITE_EFFECT_PARAMETERS, type SpriteEffect } from './rendering/text/SpriteEffect';
export { GlyphStore } from './rendering/text/GlyphStore';
export { glyphAdvance, glyphScale, layoutText, measureText, type FontSize, type PositionedGlyph, type TextAlignment } from './rendering/text/layout';
export { parseColor, parseMarkdown, plainText, type RichBlock, type RichColor, type RichDocument, type RichRun, type RichStyle } from './rendering/text/markdown';
export { layoutRichText, lineOffset, type RichDecoration, type RichFonts, type RichGlyph, type RichLayoutOptions, type RichLine, type RichTextLayout } from './rendering/text/richLayout';
export {
  UIElement, multiply as multiplyMatrix2D, translation as translationMatrix2D,
  type HorizontalAlignment, type LayoutingContext, type Matrix2D, type Thickness, type VerticalAlignment, type Visibility,
} from './ui/UIElement';
export { KeyEventArgs, RoutedEvent, RoutedEventArgs, TextEventArgs, TouchEventArgs, type RoutedEventHandler, type RoutingStrategy, type TouchAction } from './ui/events';
export { Panel, UIElementCollection } from './ui/panels/Panel';
export { Canvas } from './ui/panels/Canvas';
export { GridBase, UniformGrid } from './ui/panels/UniformGrid';
export { Grid, StripDefinition, StripDefinitionCollection, type StripType } from './ui/panels/Grid';
export { StackPanel } from './ui/panels/StackPanel';
export { Control, ContentControl, ContentDecorator, ContentPresenter } from './ui/controls/ContentControl';
export { Border } from './ui/controls/Border';
export { Button, ButtonBase, ImageButton, type ClickMode } from './ui/controls/Button';
export { ToggleButton, type ToggleState } from './ui/controls/ToggleButton';
export { ScrollingText } from './ui/controls/ScrollingText';
export { Slider } from './ui/controls/Slider';
export { ImageElement, imageSize, type StretchDirection, type StretchType } from './ui/controls/ImageElement';
export { TextBlock } from './ui/controls/TextBlock';
export { LinkEventArgs, RichTextBlock } from './ui/controls/RichTextBlock';
export { ModalElement } from './ui/controls/ModalElement';
export { ScrollBar, ScrollViewer, type Orientation, type ScrollInfo, type ScrollingMode } from './ui/controls/ScrollViewer';
export { EditText, type EditTextInputType } from './ui/controls/EditText';
export { SpriteFromSheet, SpriteFromTexture, type SpriteProvider } from './ui/sprites';
export { buildElement, UILibrary, UIPage, type UIResources } from './ui/UIPage';
export { UIComponent, type ResolutionStretch } from './ui/UIComponent';
export { UIElementLink } from './ui/UIElementLink';
export { AudioEngine } from './audio/AudioEngine';
export { AudioEmitterComponent, AudioEmitterSoundController, AudioListenerComponent } from './audio/AudioEmitterComponent';
export { Train, TrainDoor, trainSchedule, trainStateAt, type TrainSchedule, type TrainScheduleOptions, type TrainState, type TrainStop } from './world/Train';
export { Sound, SoundInstance, type PlayState } from './audio/Sound';
export { ParticleSystem } from './particles/ParticleSystem';
export { ParticleEmitter, type ParticleSimulation, type SimulationSpace, type RandomSeedMethod, type SortingPolicy } from './particles/ParticleEmitter';
export { AUTO_GPU_CAPACITY, ParticleSystemComponent, ParticleSystems } from './particles/ParticleSystemComponent';
export { GpuEmitter, SpawnRing } from './particles/GpuEmitter';
export { gust, packWind, turbulenceAt, WindField, WindZone, GPU_LOCAL_WINDS, type GlobalWind, type LocalWind } from './world/WindField';
export { Precipitation, PrecipitationSystem, PRECIPITATION_PRESETS, precipitationEmitter } from './world/Precipitation';
export { fogDensity, Weather, WEATHER_PRESETS, weatherWind, WeatherSystem, type WeatherPreset, type WeatherState, type WeatherTarget } from './world/Weather';
export { StreamingSource, WorldStreaming } from './world/WorldStreaming';
export { Terrain, TerrainAsset, TerrainTile, type TerrainAssetId } from './world/Terrain';
export { City, CityAsset, CitySystem, type CityAssetId } from './world/City';
export { Water, WaterAsset, type WaterAssetId } from './world/Water';
export { WaterRenderer } from './world/WaterRenderer';
export { Buoyancy, BuoyancySystem, waterSurfaceAt } from './world/Buoyancy';
export { Scatter, ScatterAsset, ScatterSystem, scatterCell, type GroundSample, type ScatterAssetId, type ScatterInstance } from './world/Scatter';
export { TerrainSystem, type TerrainHit } from './world/TerrainSystem';
export { cellAt, cellKey, cellOrigin, checkWorldFile, distanceToCell, worldCellPath, type WorldFile, type WorldLayer } from './content/formats/worldFormat';
export { SkyOcclusion, skyOcclusionCenter } from './world/SkyOcclusion';
export { packDepthSurface, ViewDepthSurface, type GpuDepthSurface } from './rendering/DepthSurface';
export { buildKernel, gpuUnsupported, type GpuKernel } from './particles/gpuKernel';
// 游戏自己的粒子模块（继承这几个基类、导出，场景里按类名找到）用到的
export {
  forEachSpawned, ParticleInitializer, ParticleModule, ParticleSpawner, ParticleTransform, value as particleModuleValue,
  type ParticleContext, type ParticleModuleKind, type SpawnedRange, type SpawnTarget,
} from './particles/modules';
export { ParticleUpdater, UpdaterDepthCollision, UpdaterWind } from './particles/updaters';
export { ParticleShapeBuilder, VertexWriter, type CameraAxes } from './particles/shapes';
export { MaterialCompiler, ParticleMaterial, type MaterialContext, type MaterialProgram, type UVBuilderParams, type UVFrame, type UVFrames } from './particles/material';
export { shaderClass, type ShaderClass } from './rendering/shaderClass';
export { meshEffect, MESH_EFFECT_PARAMETERS, type MeshEffect } from './rendering/mesh/meshEffect';
export { particleField, ParticlePool, type AnyParticleField, type CustomParticleField, type ParticleField } from './particles/ParticlePool';
export { RandomOffset, seedFloat } from './particles/random';
export { UISystem } from './ui/UISystem';
export { pageHelpers, type PageHelpers } from './debug/pageHelpers';
export { collectSemantics, semanticsKey, type SemanticsLine, type SemanticsNode, type SemanticsRole } from './ui/semantics';
export { SemanticsLayer } from './ui/SemanticsLayer';
export { IMPOSTOR_FRAMES, Mesh, type Bounds, type MeshData, type MeshId } from './rendering/mesh/Mesh';
export { ImpostorBaker, impostorMesh } from './rendering/mesh/Impostors';
export { browserImageDecoder, ktx2Decoder, Texture, type ImageDecodeOptions, type ImageDecoder, type TextureData, type TextureDecoder, type TextureId } from './graphics/Texture';
export { MipmapGenerator } from './graphics/MipmapGenerator';
export { MeshRenderFeature, type MeshBatch } from './rendering/mesh/MeshRenderFeature';
export {
  inRenderMask, MAX_DIRECTIONAL_LIGHTS, RENDER_GROUP_ALL, RENDER_GROUP_BAKE, RENDER_GROUP_VISIBLE, RenderStage, RenderSystem, RenderView, RootRenderFeature, type DirectionalLight, type DirectionalShadowSettings, type Lighting, type RenderContext, type RenderOutput, type ShadowMapFilter,
  type LocalLight, type SceneRenderer, type ShadowMapSize, type ShadowReceiver, type ShadowStabilization, type SkyboxLight, type Viewport,
} from './rendering/RenderSystem';
export { DirectionalShadowCascades, type CascadeRectangle } from './rendering/lighting/DirectionalShadowCascades';
export { ShadowMapRenderer } from './rendering/lighting/ShadowMapRenderer';
export { Color4, Quaternion, srgbToLinear, Vector3, type ColorLike, type QuatLike, type Vec3Like } from './data/vectors';
export { formatBool, formatColor, formatFloat, formatVector } from './data/numberFormat';
export { Decimal, type Rounding } from './data/Decimal';
export { civilFromDays, daysFromCivil, Instant, LocalDate, LocalDateTime, LocalTime } from './data/temporal';
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
} from './data/wire';
export { SplatCloud, type SplatCloudId } from './rendering/splats/SplatRenderer';
