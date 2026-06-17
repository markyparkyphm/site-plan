let map;
let points = [];
let markers = [];
let polyline = null;
let polygon = null;
let mapClickListener = null;
let drawing = false;
let onClosedCb = null;

export function initMap(elementId, onClosed) {
  onClosedCb = onClosed;
  map = new google.maps.Map(document.getElementById(elementId), {
    center: { lat: 39.5, lng: -98.35 },
    zoom: 5,
    mapTypeId: 'hybrid',
    disableDoubleClickZoom: true,
    fullscreenControl: false,
  });
  _startDrawing();
}

function _startDrawing() {
  drawing = true;
  points = [];

  polyline = new google.maps.Polyline({
    map,
    strokeColor: '#facc15',
    strokeWeight: 2,
  });

  mapClickListener = map.addListener('click', _onMapClick);
}

function _onMapClick(e) {
  if (!drawing) return;

  const pt = { lat: e.latLng.lat(), lng: e.latLng.lng() };
  points.push(pt);

  const isFirst = points.length === 1;
  const marker = new google.maps.Marker({
    position: e.latLng,
    map,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: isFirst ? 8 : 5,
      fillColor: isFirst ? '#4ade80' : '#facc15',
      fillOpacity: 1,
      strokeColor: '#111',
      strokeWeight: 1.5,
    },
    title: isFirst ? 'Click here to close' : '',
  });
  markers.push(marker);

  // Once 3+ points placed, clicking the first marker closes the polygon
  if (points.length === 3) {
    markers[0].addListener('click', _closePolygon);
  }

  polyline.setPath(points.map(p => ({ lat: p.lat, lng: p.lng })));
}

function _closePolygon() {
  if (!drawing || points.length < 3) return;
  drawing = false;

  if (mapClickListener) {
    google.maps.event.removeListener(mapClickListener);
    mapClickListener = null;
  }

  polyline.setMap(null);
  markers.forEach(m => m.setMap(null));
  markers = [];

  polygon = new google.maps.Polygon({
    paths: points,
    map,
    strokeColor: '#facc15',
    strokeWeight: 2,
    fillColor: '#facc15',
    fillOpacity: 0.15,
  });

  if (onClosedCb) onClosedCb([...points]);
}

export function clearDrawing() {
  drawing = false;
  if (mapClickListener) {
    google.maps.event.removeListener(mapClickListener);
    mapClickListener = null;
  }
  markers.forEach(m => m.setMap(null));
  markers = [];
  if (polyline) { polyline.setMap(null); polyline = null; }
  if (polygon) { polygon.setMap(null); polygon = null; }
  points = [];
  _startDrawing();
}
