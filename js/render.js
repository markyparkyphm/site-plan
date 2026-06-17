import { polysOf, rectPoly } from './geometry.js';

// Draw the full layout onto a canvas element, scaled to fit.
// Returns pixelsPerFoot so the caller can verify scale.
export function renderLayoutOnCanvas(canvas, parcelFt, layout, centroid) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const PAD = 40; // px padding around the drawing
  const { pixelsPerFoot, offsetX, offsetY } = computeTransform(parcelFt, canvas, PAD);

  function toCanvas(x, y) {
    return {
      cx: offsetX + x * pixelsPerFoot,
      cy: canvas.height - PAD - (y + Math.min(...parcelFt.map(p => p.y))) * pixelsPerFoot
            + Math.min(...parcelFt.map(p => p.y)) * pixelsPerFoot,
    };
  }

  // Re-derive a simpler transform: shift by minX/minY so everything is positive
  const minX = Math.min(...parcelFt.map(p => p.x));
  const minY = Math.min(...parcelFt.map(p => p.y));

  function ft2px(x, y) {
    return {
      cx: PAD + (x - minX) * pixelsPerFoot,
      cy: canvas.height - PAD - (y - minY) * pixelsPerFoot,
    };
  }

  // Parcel boundary
  drawPolyFt(ctx, parcelFt, ft2px, '#facc15', 'rgba(250,204,21,0.05)', 2);

  // Basin
  if (layout.detention_pond) {
    polysOf(layout.detention_pond).forEach(poly => {
      const pts = turfPolyToFt(poly, centroid);
      drawPolyFt(ctx, pts, ft2px, '#06b6d4', 'rgba(6,182,212,0.35)', 2);
    });
  }

  // Parking
  layout.parking_areas.forEach(p => {
    polysOf(p).forEach(poly => {
      const pts = turfPolyToFt(poly, centroid);
      drawPolyFt(ctx, pts, ft2px, '#fbbf24', 'rgba(251,191,36,0.35)', 2);
    });
  });

  // Driveways
  layout.driveways.forEach(d => {
    polysOf(d).forEach(poly => {
      const pts = turfPolyToFt(poly, centroid);
      drawPolyFt(ctx, pts, ft2px, '#f97316', 'rgba(249,115,22,0.35)', 2);
    });
  });

  // Buildings
  layout.buildings.forEach(b => {
    const foot = rectPoly(b.center_x_ft, b.center_y_ft, b.length_ft, b.width_ft, b.orientation_deg, centroid);
    polysOf(foot).forEach(poly => {
      const pts = turfPolyToFt(poly, centroid);
      drawPolyFt(ctx, pts, ft2px, '#ef4444', 'rgba(239,68,68,0.5)', 2);
    });

    // Label
    const { cx, cy } = ft2px(b.center_x_ft, b.center_y_ft);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${b.label} ${b.length_ft}×${b.width_ft}ft`, cx, cy);
  });

  // Scale bar
  drawScaleBar(ctx, canvas, pixelsPerFoot, PAD);

  return pixelsPerFoot;
}

function computeTransform(parcelFt, canvas, pad) {
  const minX = Math.min(...parcelFt.map(p => p.x));
  const maxX = Math.max(...parcelFt.map(p => p.x));
  const minY = Math.min(...parcelFt.map(p => p.y));
  const maxY = Math.max(...parcelFt.map(p => p.y));
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const usableW = canvas.width  - pad * 2;
  const usableH = canvas.height - pad * 2;
  const pixelsPerFoot = Math.min(usableW / spanX, usableH / spanY);
  return { pixelsPerFoot, offsetX: pad, offsetY: pad };
}

function drawPolyFt(ctx, pts, ft2px, strokeColor, fillColor, lineWidth) {
  if (!pts || pts.length < 2) return;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const { cx, cy } = ft2px(p.x, p.y);
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
  });
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

function drawScaleBar(ctx, canvas, pixelsPerFoot, pad) {
  // Pick a round number of feet that maps to 80–160px
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
  // End ticks
  [x, x + barPx].forEach(tx => {
    ctx.beginPath(); ctx.moveTo(tx, y - 4); ctx.lineTo(tx, y + 4); ctx.stroke();
  });
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${niceFt} ft`, x + barPx / 2, y - 5);
}

// Convert a WGS84 Turf polygon's coordinates to feet using the parcel centroid
function turfPolyToFt(turfPoly, centroid) {
  const s = computeScaleFactors(centroid);
  return turfPoly.geometry.coordinates[0].slice(0, -1).map(([lng, lat]) => ({
    x: (lng - centroid.lng) * s.lngToFt,
    y: (lat - centroid.lat) * s.latToFt,
  }));
}

function computeScaleFactors(centroid) {
  const METERS_PER_DEGREE_LAT = 111320;
  const FEET_PER_METER = 3.28084;
  return {
    latToFt: METERS_PER_DEGREE_LAT * FEET_PER_METER,
    lngToFt: METERS_PER_DEGREE_LAT * Math.cos(centroid.lat * Math.PI / 180) * FEET_PER_METER,
  };
}
