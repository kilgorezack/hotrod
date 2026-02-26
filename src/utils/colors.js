import { PROVIDER_COLORS } from '../config.js';

let colorIndex = 0;
const usedColors = new Map(); // providerId → colorIndex

/**
 * Assign the next available color to a provider.
 * Cycles through PROVIDER_COLORS palette.
 */
export function assignColor(providerId) {
  if (usedColors.has(providerId)) {
    return PROVIDER_COLORS[usedColors.get(providerId)];
  }
  const idx = colorIndex % PROVIDER_COLORS.length;
  colorIndex++;
  usedColors.set(providerId, idx);
  return PROVIDER_COLORS[idx];
}

/**
 * Release a color when a provider is removed.
 */
export function releaseColor(providerId) {
  usedColors.delete(providerId);
}

/**
 * Get the color assigned to a provider (or undefined if not assigned).
 */
export function getColor(providerId) {
  if (!usedColors.has(providerId)) return null;
  return PROVIDER_COLORS[usedColors.get(providerId)];
}

/**
 * Convert a hex color to rgba string.
 */
export function hexToRgba(hex, alpha = 1) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
