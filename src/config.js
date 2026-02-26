// =========================================================
// HOTROD — App Configuration & Constants
// =========================================================

/** MapKit JS token injected by Vite at build time */
export const MAPKIT_TOKEN = typeof __MAPKIT_TOKEN__ !== 'undefined' ? __MAPKIT_TOKEN__ : '';

/** Initial map region — centered on continental US */
export const INITIAL_REGION = {
  latitude: 38.5,
  longitude: -98.35,
  latitudeSpan: 22,
  longitudeSpan: 38,
};

/**
 * FCC Form 477 technology codes.
 * These are used in the opendata.fcc.gov datasets.
 */
export const TECHNOLOGY_TYPES = [
  { code: '10', label: 'Asymmetric DSL', shortLabel: 'ADSL', color: '#a78bfa' },
  { code: '11', label: 'ADSL2/ADSL2+', shortLabel: 'ADSL2', color: '#8b5cf6' },
  { code: '12', label: 'ADSL2/ADSL2+', shortLabel: 'ADSL2+', color: '#7c3aed' },
  { code: '20', label: 'Symmetric DSL', shortLabel: 'SDSL', color: '#6d28d9' },
  { code: '30', label: 'Other DSL', shortLabel: 'DSL', color: '#5b21b6' },
  { code: '40', label: 'Cable HFC', shortLabel: 'Cable', color: '#f59e0b' },
  { code: '41', label: 'Cable — DOCSIS 3.0+', shortLabel: 'DOCSIS 3+', color: '#d97706' },
  { code: '43', label: 'Cable — DOCSIS 3.1', shortLabel: 'DOCSIS 3.1', color: '#b45309' },
  { code: '50', label: 'Fiber to the Premises', shortLabel: 'Fiber', color: '#10b981' },
  { code: '60', label: 'Satellite', shortLabel: 'Satellite', color: '#3b82f6' },
  { code: '70', label: 'Terrestrial Fixed Wireless', shortLabel: 'Fixed Wireless', color: '#06b6d4' },
  { code: '90', label: 'Electric Power Line', shortLabel: 'Power Line', color: '#84cc16' },
  { code: '0',  label: 'Other', shortLabel: 'Other', color: '#6b7280' },
];

/** Lookup tech type by code */
export const TECH_BY_CODE = Object.fromEntries(
  TECHNOLOGY_TYPES.map((t) => [t.code, t])
);

/**
 * Provider overlay color palette (8 visually distinct colors
 * that work well on both light and satellite map backgrounds).
 */
export const PROVIDER_COLORS = [
  { hex: '#4F86F7', rgba: (a) => `rgba(79,134,247,${a})` },   // Blue
  { hex: '#F85149', rgba: (a) => `rgba(248,81,73,${a})` },    // Red
  { hex: '#3FB950', rgba: (a) => `rgba(63,185,80,${a})` },    // Green
  { hex: '#E3B341', rgba: (a) => `rgba(227,179,65,${a})` },   // Yellow
  { hex: '#BC8CFF', rgba: (a) => `rgba(188,140,255,${a})` },  // Purple
  { hex: '#F0883E', rgba: (a) => `rgba(240,136,62,${a})` },   // Orange
  { hex: '#39D4D4', rgba: (a) => `rgba(57,212,212,${a})` },   // Teal
  { hex: '#F778BA', rgba: (a) => `rgba(247,120,186,${a})` },  // Pink
];

/** API base path — proxied to Express backend */
export const API_BASE = '/api';
