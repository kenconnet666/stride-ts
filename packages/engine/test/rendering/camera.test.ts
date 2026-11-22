import { describe, expect, test } from 'vitest';
import { cameraVerticalFieldOfView } from '../../src/rendering/cameraRays';
import { DepthOfField } from '../../src/rendering/screenspace/DepthOfField';

describe('物理相机', () => {
  test('焦距换竖直视角：全画幅 50 毫米约 27 度；弥散圆：对焦处为 0，远处趋向系数', () => {
    expect(cameraVerticalFieldOfView({ projection: 'perspective', verticalFieldOfView: 45, orthographicSize: 1, nearClipPlane: 0.1, farClipPlane: 100, physical: true, sensorHeight: 24, focalLength: 50 })).toBeCloseTo(26.99, 2);
    expect(cameraVerticalFieldOfView({ projection: 'perspective', verticalFieldOfView: 45, orthographicSize: 1, nearClipPlane: 0.1, farClipPlane: 100 })).toBe(45);
    // 50 毫米 f/2 对焦 5 米，1080 像素高：系数 = (0.025 · 0.05 / 4.95) · (1080 / 0.024) ≈ 11.36 像素
    const scale = DepthOfField.cocScale({ focalLength: 50, aperture: 2, focusDistance: 5, sensorHeight: 24, shutterAngle: 180, exposureCompensation: 0, depthOfField: true }, 1080);
    expect(scale).toBeCloseTo(11.36, 1);
  });
});
