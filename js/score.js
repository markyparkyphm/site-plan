export const PROFILES = {
  retail: {
    // Scoring weights
    buildingsPlaced: 1.0,
    parkingMet:      0.9,
    parkingInFront:  0.7,
    roadVisibility:  0.6,
    coverageTarget:  0.5,
    accessQuality:  -0.25,
    basinAccuracy:   0.3,
    compactness:     0.15,
    openSpace:       0.0,
    // Placement defaults (used by arrange.js; solver.js falls back to the same values)
    setbackFt:            20,
    clearanceFt:          30,
    maxBuildingDepthFt:   70,
    minBuildingAreaSqFt: 400,
    stallDepthFt:         18,
    aisleFt:              24,
    drivewayWidthFt:      24,
    gapFt:                10,
    // Schema-optimizer search config — value-sets and grids for optimizeArrangement.
    // All knobs live here, not in optimize.js, so profiles control the search space.
    searchConfig: {
      // Discrete knobs (cross-product enumerated)
      layout:        ['strip'],                              // group layout for multi-building
      gapFt:         [0, 20],                               // inter-building gap (ft) inside a group
      parkingFaces:  ['front'],                             // which building faces to park against
      driveways:     [['left'], ['center'], ['right'], ['left', 'right']], // entryU sets per candidate
      basinCorner:   ['rearLeft', 'rearRight', 'frontLeft', 'frontRight'],
      // Coarse continuous knobs (sampled grid; Phase 2 refines)
      setbackFt:     [15, 25, 35],                          // parcel setback before building placement
      alignU:        ['left', 'center', 'right'],           // lateral alignment of building/group
      // Search limits
      maxCandidates: 500,   // hard cap on generator output (prevents runaway if config widens)
      topK:          4,     // candidates shown in the optimizer panel
    },
  },
};

const clamp01 = v => Math.max(0, Math.min(1, v));

function depthFromFront(pt, frontage, b) {
  switch (frontage) {
    case 'S': return pt.y - b.minY;
    case 'N': return b.maxY - pt.y;
    case 'W': return pt.x - b.minX;
    case 'E': return b.maxX - pt.x;
  }
}

function bounds(parcelFt) {
  const xs = parcelFt.map(p => p.x), ys = parcelFt.map(p => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs),
           minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function plateau(v, lo, hi, falloff) {
  if (v >= lo && v <= hi) return 1;
  if (v < lo) return clamp01(v / lo);
  return clamp01(1 - (v - hi) / falloff);
}

export function score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile) {
  const W = profile;
  const terms = {};
  const add = (name, raw) => {
    const w = W[name] ?? 0;
    terms[name] = { raw, weight: w, contribution: w * raw };
  };

  const b = bounds(parcelFt);
  const parcelDepth = (frontage === 'E' || frontage === 'W')
    ? (b.maxX - b.minX) : (b.maxY - b.minY);

  add('buildingsPlaced',
    reqs.buildings.length ? layout.buildings.length / reqs.buildings.length : 1);

  const reqStalls = reqs.parking_stalls ?? 0;
  const gotStalls = layout.parking_areas[0]?.properties?.stall_count ?? 0;
  add('parkingMet', reqStalls ? clamp01(gotStalls / reqStalls) : 1);

  if (layout.parking_areas[0] && layout.buildings.length) {
    const pk = layout.parking_areas[0].properties;
    const dPark = depthFromFront({ x: pk.center_x_ft, y: pk.center_y_ft }, frontage, b);
    const dBldg = layout.buildings.reduce((s, bl) =>
        s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
      / layout.buildings.length;
    add('parkingInFront', clamp01(0.5 + (dBldg - dPark) / parcelDepth));
  } else add('parkingInFront', 0.5);

  if (layout.buildings.length) {
    const meanSetback = layout.buildings.reduce((s, bl) =>
        s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
      / layout.buildings.length;
    add('roadVisibility', plateau(meanSetback, 60, 200, 250));
  } else add('roadVisibility', 0);

  const footprintSqFt = layout.buildings.reduce((s, bl) => s + bl.length_ft * bl.width_ft, 0);
  add('coverageTarget', plateau(footprintSqFt / parcelAreaSqFt, 0.20, 0.25, 0.20));

  const dwSqFt = layout.driveways.reduce((s, d) => s + turf.area(d) * 10.7639, 0);
  add('accessQuality', clamp01((dwSqFt / parcelAreaSqFt) / 0.05));

  const target = (reqs.pondSqFt ?? (reqs.pondPct / 100) * parcelAreaSqFt) || 0;
  if (target > 0) {
    const basinSqFt = layout.detention_pond ? turf.area(layout.detention_pond) * 10.7639 : 0;
    add('basinAccuracy', clamp01(1 - Math.abs(basinSqFt - target) / target));
  } else add('basinAccuracy', 1);

  if (layout.buildings.length > 1) {
    const cx = layout.buildings.map(bl => bl.center_x_ft);
    const cy = layout.buildings.map(bl => bl.center_y_ft);
    const spread = Math.hypot(Math.max(...cx) - Math.min(...cx), Math.max(...cy) - Math.min(...cy));
    const parcelDiag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    add('compactness', clamp01(1 - spread / parcelDiag));
  } else add('compactness', 1);

  add('openSpace', 0);

  const total = Object.values(terms).reduce((s, t) => s + t.contribution, 0);
  const maxScore = Object.values(W).filter(w => w > 0).reduce((s, w) => s + w, 0);
  return { total, maxScore, terms };
}
