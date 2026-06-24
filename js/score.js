export const PROFILES = {
  retail: {
    // Scoring weights
    buildingsPlaced: 1.0,
    parkingMet:      0.9,
    parkingInFront:  0.7,
    roadVisibility:  0.6,
    coverageTarget:  0.5,
    drivewayConnected: 0.4,
    drivewayLength:    0.3,
    drivewayPresent: 0.4,
    basinAccuracy:   0.3,
    compactness:     0.15,
    openSpace:       0.1,
    // Placement defaults (used by arrange.js; solver.js falls back to the same values)
    setbackFt:            20,
    clearanceFt:          30,
    maxBuildingDepthFt:   70,
    minBuildingAreaSqFt: 400,
    stallDepthFt:         18,
    aisleFt:              24,
    drivewayWidthFt:      24,
    defaultDriveLengthFt:    null,  // null → derive functional length (span to served element's far edge)
    drivewayConnectThreshFt: 30,
    drivewayLengthLo:        0.6,
    drivewayLengthHi:        1.0,
    drivewayLengthFalloff:   0.5,
    gapFt:                10,
    // Schema-optimizer search config — value-sets and grids for optimizeArrangement.
    // All knobs live here, not in optimize.js, so profiles control the search space.
    searchConfig: {
      // Discrete knobs (cross-product enumerated)
      layout:        ['strip', 'stacked', 'L', 'U'],           // group layout for multi-building
      gapFt:         [0, 20],                               // inter-building gap (ft) inside a group
      parkingFaces:  ['front', 'rear', 'left', 'right', 'front+rear', 'front+left', 'front+right'], // which building faces to park against
      driveways:     [['left'], ['center'], ['right'], ['left', 'right']], // entryU sets per candidate
      basinCorner:   ['rearLeft', 'rearRight', 'frontLeft', 'frontRight'],
      // Coarse continuous knobs (sampled grid; Phase 2 refines)
      setbackFt:     [15, 25, 35],                          // parcel setback before building placement
      alignU:        ['left', 'center', 'right'],           // lateral alignment of building/group
      // Search limits
      maxCandidates: 8000,  // 4 layouts×2 gaps×7 faces×4 driveways×4 corners×3 setbacks×3 align ≈ 8064
      topK:          4,     // Phase 2 refines around this many Phase 1 winners
      displayK:      10,    // rows shown in the step-through optimizer panel
      // Phase 2 local-refinement config
      refineConfig: {
        setbackStep:          2,                       // ft between fine setback samples
        setbackRange:         9,                       // ±ft around Phase 1 winner setback value
        alignOffsetsFt:       [-60, -30, 0, 30, 60],  // u-offsets (ft) from base Phase 1 alignU
        driveLengthOffsetsFt: [-40, -20, 0, 20, 40],  // ft offsets from winner's realized driveway length
      },
    },
    // Regulatory feasibility gates — checked after realization, before scoring.
    // Hard failures disqualify candidates (never ranked). Soft violations are surfaced
    // as warnings on the manual-solve path but do not disqualify.
    // Values are representative US suburban-commercial stand-ins, NOT a specific adopted code.
    // Set jurisdiction and rule params to your adopted code before trusting output.
    regConfig: {
      useType:      'retail',
      jurisdiction: 'UNVERIFIED — representative defaults, not an adopted code',
      rules: {
        parkingRatioGFA:  { enabled: true,  severity: 'hard', per1000: 4.0 },
        lotCoverage:      { enabled: true,  severity: 'hard', max: 0.80 },
        buildingCoverage: { enabled: true,  severity: 'hard', max: 0.40 },
        setbacks:         { enabled: true,  severity: 'hard', frontFt: 25, sideFt: 10, rearFt: 15 },
        aisleWidth:       { enabled: true,  severity: 'hard', minFt: 24 },
        fireLane:         { enabled: true,  severity: 'hard', minFt: 20 },
        detention:        { enabled: true,  severity: 'hard', areaPerImpervFt: 0.10, approximate: true },
        // Phase 2
        adaStalls:        { enabled: true,  severity: 'hard' },
        landscapeBuffer:  { enabled: false, severity: 'hard', bufferFt: 5 },
        openSpace:        { enabled: true,  severity: 'soft', min: 0.20 },
      },
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

export function score(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile, road = null) {
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

  // --- drivewayConnected (neutral only when no road detected; 0 when road exists but no driveway) ---
  const dwCount = layout.driveways.length;
  if (!road?.line) {
    add('drivewayConnected', 1); // no road detected — can't evaluate, stay neutral
  } else if (dwCount === 0) {
    add('drivewayConnected', 0); // road exists but no driveway → not connected
  } else {
    const connectThreshFt = profile.drivewayConnectThreshFt ?? 30;
    const roadBuf = turf.buffer(road.line, connectThreshFt, { units: 'feet' });
    let connected = 0;
    for (const d of layout.driveways) {
      if (roadBuf && turf.booleanIntersects(d, roadBuf)) connected++;
    }
    add('drivewayConnected', clamp01(connected / dwCount));
  }

  // --- drivewayLength: reward lanes that span the parking depth, penalize gross overshoot ---
  if (dwCount === 0 || layout.buildings.length === 0) {
    add('drivewayLength', 1);
  } else {
    const meanBldgDepth = layout.buildings.reduce((s, bl) =>
        s + depthFromFront({ x: bl.center_x_ft, y: bl.center_y_ft }, frontage, b), 0)
      / layout.buildings.length;
    const faceDepthFt = Math.max(40, meanBldgDepth);
    const lo      = profile.drivewayLengthLo       ?? 0.6;
    const hi      = profile.drivewayLengthHi       ?? 1.0;
    const falloff = profile.drivewayLengthFalloff   ?? 0.5;
    const raws = layout.driveways.map(d => {
      const L = d.properties?.lengthFt ?? 0;
      return plateau(L / faceDepthFt, lo, hi, falloff);
    });
    add('drivewayLength', raws.reduce((s, r) => s + r, 0) / raws.length);
  }

  add('drivewayPresent', layout.driveways.length > 0 ? 1 : 0);

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

  const parkSqFt  = layout.parking_areas.reduce((s, p) => s + turf.area(p) * 10.7639, 0);
  const dwSqFt    = layout.driveways.reduce((s, d) => s + turf.area(d) * 10.7639, 0);
  const openRatio = Math.max(0, 1 - (footprintSqFt + parkSqFt + dwSqFt) / parcelAreaSqFt);
  const openMin   = profile.regConfig?.rules?.openSpace?.min ?? 0.20;
  add('openSpace', plateau(openRatio, openMin, 1.0, 1.0));

  const total    = Object.values(terms).reduce((s, t) => s + t.contribution, 0);
  const maxScore = Object.values(terms).reduce((s, t) => t.weight > 0 ? s + t.weight : s, 0);
  return { total, maxScore, terms };
}
