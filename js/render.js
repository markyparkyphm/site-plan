import { polysOf, rectPoly } from './geometry.js';
import { feetToLatLngFromCentroid } from './projection.js';

function lngLatToWorldPx(lng, lat, zoom) {
  const size = 256 * Math.pow(2, zoom);
  const x = (lng + 180) / 360 * size;
  const s = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size;
  return { x, y };
}

// Draw the full layout onto a canvas element with a satellite background.
// Uses Web Mercator projection so imagery and polygons align by construction.
export async function renderLayoutOnCanvas(canvas, parcelLatLng, layout, centroid) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const PAD = 40;
  // Static Maps logical size (capped at 640); scale=2 in the URL gives 2x pixel density
  const staticW = 640;
  const staticH = Math.round(staticW * canvas.height / canvas.width);
  // canvas pixels per Mercator world pixel
  const mercScale = canvas.width / staticW;

  // Find largest integer zoom at which the parcel fits inside the canvas (minus padding)
  let zoom = 21;
  for (; zoom >= 1; zoom--) {
    const c = lngLatToWorldPx(centroid.lng, centroid.lat, zoom);
    let maxDx = 0, maxDy = 0;
    for (const p of parcelLatLng) {
      const wp = lngLatToWorldPx(p.lng, p.lat, zoom);
      maxDx = Math.max(maxDx, Math.abs(wp.x - c.x));
      maxDy = Math.max(maxDy, Math.abs(wp.y - c.y));
    }
    if (maxDx * 2 * mercScale <= canvas.width  - 2 * PAD &&
        maxDy * 2 * mercScale <= canvas.height - 2 * PAD) break;
  }

  const cWorld = lngLatToWorldPx(centroid.lng, centroid.lat, zoom);

  function project(lng, lat) {
    const p = lngLatToWorldPx(lng, lat, zoom);
    return {
      cx: canvas.width  / 2 + (p.x - cWorld.x) * mercScale,
      cy: canvas.height / 2 + (p.y - cWorld.y) * mercScale,
    };
  }

  // crossOrigin must be set before src, otherwise canvas.toDataURL() taints the canvas
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise(resolve => {
    img.onload = resolve;
    img.onerror = resolve; // proceed with dark background on failure
    img.src = `https://maps.googleapis.com/maps/api/staticmap`
      + `?center=${centroid.lat},${centroid.lng}&zoom=${zoom}`
      + `&size=${staticW}x${staticH}&scale=2&maptype=satellite&key=${window.MAPS_API_KEY}`;
  });

  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (img.naturalWidth > 0) {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }

  function turfPolyToCanvas(poly) {
    return poly.geometry.coordinates[0].slice(0, -1).map(([lng, lat]) => project(lng, lat));
  }

  function drawPoly(pts, strokeColor, fillColor, lineWidth) {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    pts.forEach(({ cx, cy }, i) => i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy));
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  // Draw order: parcel → basin → parking → driveways → buildings → scale bar
  drawPoly(parcelLatLng.map(p => project(p.lng, p.lat)), '#facc15', 'rgba(250,204,21,0.05)', 2);

  if (layout.detention_pond) {
    polysOf(layout.detention_pond).forEach(poly =>
      drawPoly(turfPolyToCanvas(poly), '#06b6d4', 'rgba(6,182,212,0.35)', 2));
  }

  layout.parking_areas.forEach(p =>
    polysOf(p).forEach(poly =>
      drawPoly(turfPolyToCanvas(poly), '#fbbf24', 'rgba(251,191,36,0.35)', 2)));

  layout.driveways.forEach(d =>
    polysOf(d).forEach(poly =>
      drawPoly(turfPolyToCanvas(poly), '#f97316', 'rgba(249,115,22,0.35)', 2)));

  layout.buildings.forEach(b => {
    const foot = rectPoly(b.center_x_ft, b.center_y_ft, b.length_ft, b.width_ft, b.orientation_deg, centroid);
    polysOf(foot).forEach(poly =>
      drawPoly(turfPolyToCanvas(poly), '#ef4444', 'rgba(239,68,68,0.5)', 2));

    const center = feetToLatLngFromCentroid({ x: b.center_x_ft, y: b.center_y_ft }, centroid);
    const { cx, cy } = project(center.lng, center.lat);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${b.label} ${b.length_ft}×${b.width_ft}ft`, cx, cy);
  });

  // Scale bar derived from Mercator zoom (independent of bbox transform)
  const metersPerWorldPx = Math.cos(centroid.lat * Math.PI / 180) * 2 * Math.PI * 6378137
    / (256 * Math.pow(2, zoom));
  const pixelsPerFoot = mercScale / (metersPerWorldPx * 3.28084);
  drawScaleBar(ctx, canvas, pixelsPerFoot, PAD);
}

function drawScaleBar(ctx, canvas, pixelsPerFoot, pad) {
  const targetPx = 120;
  const targetFt = targetPx / pixelsPerFoot;
  const magnitude = Math.pow(10, Math.floor(Math.log10(targetFt)));
  const niceFt = [1, 2, 5, 10].map(m => m * magnitude)
    .find(v => v * pixelsPerFoot >= 80) ?? magnitude * 10;
  const barPx = niceFt * pixelsPerFoot;

  const x = pad;
  const y = canvas.height - 14;

  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.stroke();
  [x, x + barPx].forEach(tx => {
    ctx.beginPath(); ctx.moveTo(tx, y - 4); ctx.lineTo(tx, y + 4); ctx.stroke();
  });
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${niceFt} ft`, x + barPx / 2, y - 5);
}
