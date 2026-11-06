export interface MapAppearance {
  base: 'road' | 'satellite';
  overlay: 'none' | 'transit' | 'traffic' | 'bike';
  contrast: boolean;
}

export const DEFAULT_MAP_APPEARANCE: Readonly<MapAppearance> = Object.freeze({
  base: 'road',
  overlay: 'none',
  contrast: false
});

/** Accept only the cosmetic fields supported by the map provider. */
export function normalizeMapAppearance(value: unknown): MapAppearance {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ...DEFAULT_MAP_APPEARANCE };
  const fields = value as Partial<MapAppearance>;
  return {
    base: fields.base === 'satellite' ? 'satellite' : 'road',
    overlay:
      fields.overlay === 'transit' ||
      fields.overlay === 'traffic' ||
      fields.overlay === 'bike'
        ? fields.overlay
        : 'none',
    contrast: fields.contrast === true
  };
}
