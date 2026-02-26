import { MAPKIT_TOKEN, INITIAL_REGION } from '../config.js';

/** Shared map instance (set after init) */
export let map = null;

/** Resolves when MapKit JS is ready */
let mapKitReadyResolve;
export const mapKitReady = new Promise((resolve) => {
  mapKitReadyResolve = resolve;
});

/**
 * Called by the MapKit JS CDN script via data-callback="hotrodMapKitReady".
 * Exposed on window so the CDN script can call it.
 */
window.hotrodMapKitReady = function () {
  mapKitReadyResolve();
};

/**
 * Initialize MapKit JS and create the map.
 * Must be called after MapKit JS finishes loading.
 */
export async function initMap() {
  // Wait for MapKit CDN to signal ready
  await mapKitReady;

  if (!MAPKIT_TOKEN) {
    console.warn(
      '[HOTROD] MAPKIT_TOKEN is not set. Map will not render.\n' +
      'Set MAPKIT_TOKEN in your .env file and restart the dev server.'
    );
    showMapTokenWarning();
    return null;
  }

  mapkit.init({
    authorizationCallback: (done) => {
      done(MAPKIT_TOKEN);
    },
  });

  map = new mapkit.Map('map', {
    region: new mapkit.CoordinateRegion(
      new mapkit.Coordinate(INITIAL_REGION.latitude, INITIAL_REGION.longitude),
      new mapkit.CoordinateSpan(INITIAL_REGION.latitudeSpan, INITIAL_REGION.longitudeSpan)
    ),
    showsZoomControl: true,
    showsCompass: mapkit.FeatureVisibility.Hidden,
    showsMapTypeControl: false,
    showsScale: mapkit.FeatureVisibility.Adaptive,
    colorScheme: mapkit.Map.ColorSchemes.Light,
    isRotationEnabled: false,
  });

  return map;
}

function showMapTokenWarning() {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  mapEl.innerHTML = `
    <div style="
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100%;color:#8b949e;font-family:Inter,sans-serif;text-align:center;padding:40px;
      background:#0d1117;
    ">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" style="margin-bottom:16px;opacity:0.4">
        <circle cx="24" cy="24" r="20" stroke="currentColor" stroke-width="2"/>
        <path d="M24 14v14M24 34v2" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
      <p style="font-size:15px;font-weight:600;color:#e6edf3;margin-bottom:8px">MapKit JS token required</p>
      <p style="font-size:13px;max-width:300px;line-height:1.6">
        Add your Apple MapKit JS token to <code style="color:#5865f2">.env</code> as
        <code style="color:#5865f2">MAPKIT_TOKEN=…</code> and restart.
      </p>
      <a
        href="https://developer.apple.com/documentation/mapkitjs/creating-a-maps-token"
        target="_blank"
        rel="noopener"
        style="margin-top:16px;color:#5865f2;font-size:13px;"
      >How to create a MapKit JS token →</a>
    </div>
  `;
}
