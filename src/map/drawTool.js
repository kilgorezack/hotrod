/**
 * drawTool.js — interactive polygon draw mode for MapKit JS.
 *
 * Usage:
 *   initDrawTool(mapInstance, { onPolygonComplete, onCancel })
 *   startDraw()   — enter draw mode
 *   stopDraw()    — exit draw mode (clears state + overlays)
 *   isDrawing()   — returns true while in draw mode
 *
 * UX:
 *   - Click to place each vertex; a live polyline preview follows
 *   - Double-click OR click within 20px of the first vertex to close
 *   - Escape key cancels
 *   - Minimum 3 vertices required to close
 */

// Module-level state
let _map = null;
let _onComplete = null;
let _onCancel = null;

let _drawing = false;
let _vertices = [];       // mapkit.Coordinate[]
let _previewLine = null;  // mapkit.PolylineOverlay (in-progress path)
let _closedPoly = null;   // mapkit.PolygonOverlay (shown while loading results)
let _firstMarker = null;  // small PolygonOverlay marking the start vertex

// Click debounce: skip clicks that are part of a double-click
let _lastClickTime = 0;

// ─── Public API ───────────────────────────────────────────────────────────────

export function initDrawTool(mapInstance, { onPolygonComplete, onCancel }) {
  _map       = mapInstance;
  _onComplete = onPolygonComplete;
  _onCancel   = onCancel;
}

export function startDraw() {
  if (!_map) return;
  _drawing = true;
  _vertices = [];
  _lastClickTime = 0;

  _map.element.classList.add('draw-mode');
  _map.element.addEventListener('click',   _handleClick);
  _map.element.addEventListener('dblclick', _handleDblClick);
  document.addEventListener('keydown', _handleKey);
}

export function stopDraw() {
  _drawing = false;
  _vertices = [];

  if (_map) {
    _map.element.classList.remove('draw-mode');
    _map.element.removeEventListener('click',   _handleClick);
    _map.element.removeEventListener('dblclick', _handleDblClick);
    _removeOverlays();
  }
  document.removeEventListener('keydown', _handleKey);
}

/** Remove the selection polygon overlay (call after results are dismissed). */
export function clearSelectionOverlay() {
  if (_map && _closedPoly) {
    try { _map.removeOverlay(_closedPoly); } catch { /* already removed */ }
    _closedPoly = null;
  }
}

export function isDrawing() { return _drawing; }

// ─── Coordinate conversion ────────────────────────────────────────────────────

function _toCoord(pageX, pageY) {
  // convertPointOnPageToCoordinate accepts a DOMPoint or {x,y}
  return _map.convertPointOnPageToCoordinate(new DOMPoint(pageX, pageY));
}

function _toPage(coord) {
  return _map.convertCoordinateToPointOnPage(coord);
}

/** Pixel distance between two page points. */
function _pixelDist(p1, p2) {
  const dx = p1.x - p2.x, dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ─── Event handlers ───────────────────────────────────────────────────────────

function _handleClick(event) {
  if (!_drawing) return;

  // Skip the second click of a double-click (fired < 300ms after the first)
  const now = Date.now();
  if (now - _lastClickTime < 300) return;
  _lastClickTime = now;

  const coord = _toCoord(event.pageX, event.pageY);
  if (!coord) return;

  // Auto-close if clicking near the first vertex (20px threshold, need ≥3 verts)
  if (_vertices.length >= 3) {
    const firstPage = _toPage(_vertices[0]);
    if (firstPage && _pixelDist({ x: event.pageX, y: event.pageY }, firstPage) < 20) {
      _closePolygon();
      return;
    }
  }

  _addVertex(coord);
}

function _handleDblClick(event) {
  if (!_drawing) return;
  event.stopPropagation();
  if (_vertices.length >= 3) _closePolygon();
}

function _handleKey(event) {
  if (!_drawing) return;
  if (event.key === 'Escape') {
    stopDraw();
    if (_onCancel) _onCancel();
  }
}

// ─── Drawing logic ────────────────────────────────────────────────────────────

function _addVertex(coord) {
  _vertices.push(coord);
  _updatePreview();

  // Show a small circle at the first vertex to hint "click here to close"
  if (_vertices.length === 1) {
    _addFirstMarker(coord);
  }
}

function _addFirstMarker(coord) {
  if (_firstMarker) { try { _map.removeOverlay(_firstMarker); } catch {} }
  // Tiny circle: place 4 offset points ~0.001° around the vertex
  const d = 0.003;
  const pts = [
    new mapkit.Coordinate(coord.latitude + d, coord.longitude),
    new mapkit.Coordinate(coord.latitude,     coord.longitude + d),
    new mapkit.Coordinate(coord.latitude - d, coord.longitude),
    new mapkit.Coordinate(coord.latitude,     coord.longitude - d),
  ];
  _firstMarker = new mapkit.PolygonOverlay(pts, {
    style: new mapkit.Style({
      fillColor:   '#4F86F7',
      fillOpacity: 0.8,
      strokeColor: '#ffffff',
      strokeOpacity: 1,
      lineWidth:   1.5,
    }),
  });
  _map.addOverlay(_firstMarker);
}

function _updatePreview() {
  if (_previewLine) {
    try { _map.removeOverlay(_previewLine); } catch {}
    _previewLine = null;
  }
  if (_vertices.length < 2) return;

  _previewLine = new mapkit.PolylineOverlay(_vertices, {
    style: new mapkit.Style({
      strokeColor:   '#4F86F7',
      strokeOpacity: 0.9,
      lineWidth:     2,
    }),
  });
  _map.addOverlay(_previewLine);
}

function _closePolygon() {
  if (_vertices.length < 3) return;
  _drawing = false;

  _map.element.classList.remove('draw-mode');
  _map.element.removeEventListener('click',    _handleClick);
  _map.element.removeEventListener('dblclick', _handleDblClick);
  document.removeEventListener('keydown', _handleKey);

  // Remove in-progress overlays, show closed polygon
  _removeOverlays();

  _closedPoly = new mapkit.PolygonOverlay(_vertices, {
    style: new mapkit.Style({
      fillColor:     '#4F86F7',
      fillOpacity:   0.12,
      strokeColor:   '#4F86F7',
      strokeOpacity: 0.7,
      lineWidth:     2,
    }),
  });
  _map.addOverlay(_closedPoly);

  // Pass plain {latitude, longitude} objects — no MapKit dependency in callers
  const verts = _vertices.map(c => ({ latitude: c.latitude, longitude: c.longitude }));
  _vertices = [];

  if (_onComplete) _onComplete(verts);
}

function _removeOverlays() {
  for (const overlay of [_previewLine, _firstMarker]) {
    if (overlay) { try { _map.removeOverlay(overlay); } catch {} }
  }
  _previewLine = null;
  _firstMarker = null;
}
