import * as THREE from 'three';
import { PLAYER_COLORS } from '../game/types';

/**
 * Each colour carries a distinct etched marking so colour is never the only
 * signal. Drawn once into small canvases and cached for the life of the page.
 */
const cache = new Map<number, THREE.Texture>();

export function glyphTexture(colorIndex: number): THREE.Texture {
  const cached = cache.get(colorIndex);
  if (cached) return cached;

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  const color = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
  ctx.clearRect(0, 0, size, size);
  ctx.font = `${Math.round(size * 0.62)}px system-ui, "Segoe UI Symbol", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color.ink;
  ctx.globalAlpha = 0.5;
  ctx.fillText(color.glyph, size / 2, size / 2 + size * 0.02);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  cache.set(colorIndex, texture);
  return texture;
}

export function disposeGlyphs(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}

/** Vertical gradient used as the scene background. */
export function backgroundTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  // Deeper towards the bottom so the near-white board reads as an object
  // sitting on a surface rather than blending into the page.
  gradient.addColorStop(0, '#ffd9ec');
  gradient.addColorStop(0.5, '#ffbcdb');
  gradient.addColorStop(1, '#ff9fca');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 256);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
