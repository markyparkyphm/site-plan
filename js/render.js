import { polysOf, rectPoly } from './geometry.js';
import { feetToLatLngFromCentroid, latLngToFeetFromCentroid } from './projection.js';

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
    if (lineWidth > 0) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  }

  function offsetPts(pts, dx, dy) {
    return pts.map(({ cx, cy }) => ({ cx: cx + dx, cy: cy + dy }));
  }

  function buildingPts(b, insetFt = 0) {
    const L = b.length_ft - 2 * insetFt;
    const W = b.width_ft  - 2 * insetFt;
    if (L <= 0 || W <= 0) return null;
    const foot = rectPoly(b.center_x_ft, b.center_y_ft, L, W, b.orientation_deg ?? 0, centroid);
    const poly = polysOf(foot)[0];
    return poly ? turfPolyToCanvas(poly) : null;
  }

  function longAxisEndpointsFt(poly) {
    const ring = poly.geometry.coordinates[0].slice(0, -1)
      .map(([lng, lat]) => latLngToFeetFromCentroid({ lng, lat }, centroid));
    if (ring.length < 3) return null;

    let dir = null, maxLen = -1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len > maxLen) { maxLen = len; dir = { x: dx / len, y: dy / len }; }
    }
    if (!dir) return null;

    const cxf = ring.reduce((s, p) => s + p.x, 0) / ring.length;
    const cyf = ring.reduce((s, p) => s + p.y, 0) / ring.length;

    let sMin = Infinity, sMax = -Infinity;
    for (const p of ring) {
      const s = (p.x - cxf) * dir.x + (p.y - cyf) * dir.y;
      if (s < sMin) sMin = s; if (s > sMax) sMax = s;
    }
    const inset = 4;
    const s0 = sMin + inset, s1 = sMax - inset;
    if (s1 <= s0) return null;
    return [
      { x: cxf + dir.x * s0, y: cyf + dir.y * s0 },
      { x: cxf + dir.x * s1, y: cyf + dir.y * s1 },
    ];
  }

  function bilerp(ring, uF, vF) {
    const [P00, P10, P11, P01] = ring;
    const a = (1-uF)*(1-vF), b = uF*(1-vF), c = uF*vF, d = (1-uF)*vF;
    return {
      lng: a*P00[0] + b*P10[0] + c*P11[0] + d*P01[0],
      lat: a*P00[1] + b*P10[1] + c*P11[1] + d*P01[1],
    };
  }

  // Draw order: parcel → basin → parking → driveways → buildings → scale bar
  drawPoly(parcelLatLng.map(p => project(p.lng, p.lat)), '#facc15', 'rgba(250,204,21,0.05)', 2);

  const BASIN = {
    water: 'rgba(14,116,144,0.5)', edge: '#0e7490',
    bank:  'rgba(45,212,191,0.35)',
  };

  if (layout.detention_pond) {
    polysOf(layout.detention_pond).forEach(poly => {
      drawPoly(turfPolyToCanvas(poly), BASIN.edge, BASIN.water, 1.5);

      for (const insetFt of [6, 14]) {
        let inner = null;
        try { inner = turf.buffer(poly, -insetFt, { units: 'feet' }); } catch (_) { inner = null; }
        const piece = inner && polysOf(inner)[0];
        if (piece) drawPoly(turfPolyToCanvas(piece), BASIN.bank, 'rgba(0,0,0,0)', 1);
      }
    });
  }

  const ASPHALT = { fill: 'rgba(38,40,46,0.58)', edge: '#11151c' };
  const STRIPE  = 'rgba(255,255,255,0.7)';
  const AISLE   = 'rgba(255,255,255,0.18)';

  layout.parking_areas.forEach(p => {
    const grid = p.properties?.grid;

    polysOf(p).forEach(poly =>
      drawPoly(turfPolyToCanvas(poly), ASPHALT.edge, ASPHALT.fill, 1.5));

    if (!grid) return;

    const { ring, rows, stallsPerRow, stallDepthFt, aisleFt } = grid;
    const rowBandFt = stallDepthFt + aisleFt / 2;
    const totalVFt  = rows * rowBandFt;

    for (let r = 0; r < rows; r++) {
      const vStall0 = (r * rowBandFt) / totalVFt;
      const vStall1 = (r * rowBandFt + stallDepthFt) / totalVFt;
      const vAisle  = (r * rowBandFt + stallDepthFt + aisleFt / 4) / totalVFt;

      for (let c = 0; c < stallsPerRow; c++) {
        const uMidF    = (c + 0.5) / stallsPerRow;
        const centerLL = bilerp(ring, uMidF, (vStall0 + vStall1) / 2);
        if (!turf.booleanPointInPolygon(turf.point([centerLL.lng, centerLL.lat]), p)) continue;

        const u0 = c / stallsPerRow, u1 = (c + 1) / stallsPerRow;
        const corners = [
          bilerp(ring, u0, vStall0), bilerp(ring, u1, vStall0),
          bilerp(ring, u1, vStall1), bilerp(ring, u0, vStall1),
        ].map(({ lng, lat }) => project(lng, lat));
        drawPoly(corners, STRIPE, 'rgba(0,0,0,0)', 1);
      }

      const aL = project(bilerp(ring, 0, vAisle).lng, bilerp(ring, 0, vAisle).lat);
      const aR = project(bilerp(ring, 1, vAisle).lng, bilerp(ring, 1, vAisle).lat);
      ctx.strokeStyle = AISLE; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(aL.cx, aL.cy); ctx.lineTo(aR.cx, aR.cy); ctx.stroke();
    }

    const pk = p.properties;
    if (pk?.center_x_ft != null) {
      const ll = feetToLatLngFromCentroid({ x: pk.center_x_ft, y: pk.center_y_ft }, centroid);
      const { cx, cy } = project(ll.lng, ll.lat);
      const text = `${pk.stall_count} stalls`;
      ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.strokeText(text, cx, cy);
      ctx.fillStyle = '#fff'; ctx.fillText(text, cx, cy);
    }
  });

  const DRIVE = { fill: 'rgba(44,46,52,0.6)', edge: '#11151c', center: 'rgba(250,204,21,0.55)' };

  layout.driveways.forEach(d =>
    polysOf(d).forEach(poly => {
      drawPoly(turfPolyToCanvas(poly), DRIVE.edge, DRIVE.fill, 1.5);

      const ends = longAxisEndpointsFt(poly);
      if (ends) {
        const a = feetToLatLngFromCentroid(ends[0], centroid);
        const b = feetToLatLngFromCentroid(ends[1], centroid);
        const pa = project(a.lng, a.lat), pb = project(b.lng, b.lat);
        ctx.save();
        ctx.strokeStyle = DRIVE.center; ctx.lineWidth = 2; ctx.setLineDash([10, 8]);
        ctx.beginPath(); ctx.moveTo(pa.cx, pa.cy); ctx.lineTo(pb.cx, pb.cy); ctx.stroke();
        ctx.restore();
      }
    }));

  const ROOF      = { fill: 'rgba(60,68,84,0.92)', edge: '#0f1420', parapet: 'rgba(255,255,255,0.22)' };
  const ENTRY     = 'rgba(250,204,21,0.95)';
  const SHADOW    = 'rgba(0,0,0,0.28)';
  const SHADOW_PX = 5;

  layout.buildings.forEach(b => {
    const footPts = buildingPts(b);
    if (!footPts) return;

    // Drop shadow (fill only — lineWidth 0 skips stroke via guard above)
    drawPoly(offsetPts(footPts, SHADOW_PX, SHADOW_PX), 'rgba(0,0,0,0)', SHADOW, 0);

    // Roof fill + crisp edge
    drawPoly(footPts, ROOF.edge, ROOF.fill, 1.5);

    // Inset parapet line (skip tiny footprints)
    const inner = buildingPts(b, 6);
    if (inner) drawPoly(inner, ROOF.parapet, 'rgba(0,0,0,0)', 1);

    // Entry marker on the wall nearest the parking
    const pk = layout.parking_areas[0]?.properties;
    if (pk) {
      const rad = (b.orientation_deg ?? 0) * Math.PI / 180;
      const ax  = { x: Math.cos(rad),  y: Math.sin(rad)  };
      const px  = { x: -Math.sin(rad), y: Math.cos(rad)  };
      const hl  = b.length_ft / 2, hw = b.width_ft / 2;

      const mids = [
        { x: b.center_x_ft + ax.x*hl, y: b.center_y_ft + ax.y*hl, perp: true  },
        { x: b.center_x_ft - ax.x*hl, y: b.center_y_ft - ax.y*hl, perp: true  },
        { x: b.center_x_ft + px.x*hw, y: b.center_y_ft + px.y*hw, perp: false },
        { x: b.center_x_ft - px.x*hw, y: b.center_y_ft - px.y*hw, perp: false },
      ];
      const near = mids.reduce((best, m) => {
        const dx = m.x - pk.center_x_ft, dy = m.y - pk.center_y_ft;
        const d2 = dx*dx + dy*dy;
        return d2 < best.d2 ? { m, d2 } : best;
      }, { m: null, d2: Infinity }).m;

      const eLen = near.perp ? 3 : 8;
      const eWid = near.perp ? 8 : 3;
      const eRect = rectPoly(near.x, near.y, eLen, eWid, b.orientation_deg ?? 0, centroid);
      const ePoly = polysOf(eRect)[0];
      if (ePoly) drawPoly(turfPolyToCanvas(ePoly), ROOF.edge, ENTRY, 1);
    }

    // Label with dark halo for legibility
    const center = feetToLatLngFromCentroid({ x: b.center_x_ft, y: b.center_y_ft }, centroid);
    const { cx, cy } = project(center.lng, center.lat);
    const text = `${b.label} ${b.length_ft}×${b.width_ft}ft`;
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.strokeText(text, cx, cy);
    ctx.fillStyle = '#fff'; ctx.fillText(text, cx, cy);
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
