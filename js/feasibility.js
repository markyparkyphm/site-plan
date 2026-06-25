// feasibility.js — pre-solve program/parcel fit check. Pure, deterministic, advisory.
// Estimates whether the program CAN fit before the optimizer runs, so the user gets a clear
// explanation instead of a silently degraded plan. Mirrors the regulatory gates and the
// arrange.js depth math; never places anything.
import { buildLocalFrame, feetToLocal } from './arrange.js';
import { splitStallsByGFA } from './optimize.js';

const pct = x => `${Math.round(x * 100)}%`;
const ft  = x => `${Math.round(x).toLocaleString()} ft`;
const sf  = x => `${Math.round(x).toLocaleString()} sq ft`;

export function checkProgramFits(reqs, parcelFt, parcelAreaSqFt, frontage, profile) {
  const blockers = [];
  const warnings = [];

  const stallWidthFt = profile.stallWidthFt ?? 9;
  const rowDepthFt    = (profile.stallDepthFt ?? 18) + (profile.aisleFt ?? 24) / 2; // 30
  const sqFtPerStall  = stallWidthFt * rowDepthFt;                                  // 270
  const setbackFt     = profile.setbackFt ?? 20;

  const buildings = reqs.buildings ?? [];
  const stalls    = reqs.parking_stalls ?? 0;

  const gfa          = buildings.reduce((s, b) => s + b.length_ft * b.width_ft, 0);
  const footprintSqFt = gfa; // rectangular footprints
  const parkingSqFt   = stalls * sqFtPerStall;
  const drivewaySqFt  = (reqs.driveways ?? 0) * 24 * 60; // coarse lane estimate
  const impervSqFt    = footprintSqFt + parkingSqFt + drivewaySqFt;
  const coverageRatio = parcelAreaSqFt > 0 ? impervSqFt / parcelAreaSqFt : Infinity;

  // Parcel envelope in the frontage frame: depth = into lot (n̂), width = along frontage (t̂).
  // Uses MAX perpendicular extent (best-case deepest spot) so we never over-block.
  const frame = buildLocalFrame(frontage);
  const local = parcelFt.map(p => feetToLocal(p, frame));
  const us = local.map(p => p.u), vs = local.map(p => p.v);
  const parcelWidthFt = Math.max(...us) - Math.min(...us);
  const parcelDepthFt = Math.max(...vs) - Math.min(...vs);

  // Building strip dimensions (mirror realizeGroup's spec derivation).
  const specs = buildings.map(b => {
    const area  = b.length_ft * b.width_ft;
    const depth = Math.min(Math.min(b.length_ft, b.width_ft), Math.sqrt(area));
    return { depth, face: area / depth };
  });
  const stripWidthFt    = specs.reduce((s, x) => s + x.face, 0);
  const buildingDepthFt = specs.length ? Math.max(...specs.map(x => x.depth)) : 0;

  // Front/rear parking: stacked in front of the strip → needs DEPTH.
  // Per-building rows over its own face; co-linear strip → pushed back by the deepest.
  const shares = splitStallsByGFA(buildings, stalls);
  let frontParkDepthFt = 0;
  specs.forEach((x, i) => {
    const spr = Math.max(1, Math.floor(x.face / stallWidthFt));
    frontParkDepthFt = Math.max(frontParkDepthFt, Math.ceil((shares[i] || 0) / spr) * rowDepthFt);
  });
  const frontDepthNeed = setbackFt + frontParkDepthFt + buildingDepthFt;
  const frontWidthNeed = stripWidthFt;

  // Side parking: lots off the strip's flanks → needs WIDTH, only building depth.
  const sideParkWidthFt = buildingDepthFt > 0 ? (parkingSqFt / buildingDepthFt) / 2 : Infinity;
  const sideDepthNeed   = setbackFt + buildingDepthFt;
  const sideWidthNeed   = stripWidthFt + 2 * sideParkWidthFt;

  const frontFits = frontDepthNeed <= parcelDepthFt && frontWidthNeed <= parcelWidthFt;
  const sideFits  = sideDepthNeed  <= parcelDepthFt && sideWidthNeed  <= parcelWidthFt;

  // ---------- Hard blockers ----------
  // 1. Lot coverage (orientation-independent hard gate).
  const covMax = profile.regConfig?.rules?.lotCoverage?.max ?? 0.80;
  if (coverageRatio > covMax) {
    const maxStalls = Math.max(0, Math.floor((covMax * parcelAreaSqFt - footprintSqFt - drivewaySqFt) / sqFtPerStall));
    blockers.push(
      `Impervious area ≈ ${pct(coverageRatio)} of the parcel, over the ${pct(covMax)} lot-coverage limit. ` +
      `At this building size the parcel supports ≤ ~${maxStalls.toLocaleString()} stalls — reduce stalls or shrink the buildings.`
    );
  }

  // 2. Parking-ratio gate: requested stalls must meet the GFA-derived minimum.
  const per1000 = profile.regConfig?.rules?.parkingRatioGFA?.per1000 ?? 4.0;
  const requiredStalls = Math.ceil(gfa / 1000 * per1000);
  if (gfa > 0 && stalls < requiredStalls) {
    blockers.push(
      `${sf(gfa)} of building requires ≥ ${requiredStalls.toLocaleString()} stalls (${per1000}/1,000 sq ft); ` +
      `you requested ${stalls.toLocaleString()}. Add stalls or reduce building size.`
    );
  }

  // 3. Envelope: must fit in at least one orientation.
  if (specs.length && !frontFits && !sideFits) {
    blockers.push(
      `Buildings + parking don't fit the parcel envelope in any orientation. ` +
      `Front-loaded needs ~${ft(frontDepthNeed)} deep × ${ft(frontWidthNeed)} wide; ` +
      `side-loaded needs ~${ft(sideDepthNeed)} deep × ${ft(sideWidthNeed)} wide; ` +
      `parcel provides ~${ft(parcelDepthFt)} deep × ${ft(parcelWidthFt)} wide along the ${frontage} frontage. ` +
      `Reduce stalls or building size.`
    );
  } else if (specs.length && !frontFits && sideFits) {
    warnings.push(
      `Front parking won't fit the depth here (~${ft(frontDepthNeed)} needed, ~${ft(parcelDepthFt)} available) — ` +
      `the optimizer will need a side-loaded layout.`
    );
  }

  // ---------- Soft warnings ----------
  // Detention basin sizing vs impervious.
  const basinPct  = (reqs.pondPct ?? 0) / 100;
  const availBasin = basinPct * parcelAreaSqFt;
  const perImperv = profile.regConfig?.rules?.detention?.areaPerImpervFt ?? 0.10;
  const reqBasin  = perImperv * impervSqFt;
  if (reqBasin > 0 && availBasin < reqBasin) {
    const needPct = Math.ceil(reqBasin / parcelAreaSqFt * 100);
    warnings.push(
      `Basin at ${(basinPct * 100).toFixed(0)}% ≈ ${sf(availBasin)}, below the ~${sf(reqBasin)} detention needs ` +
      `(${perImperv}× impervious). Raise basin to ≥ ~${needPct}%.`
    );
  }

  return {
    fits: blockers.length === 0,
    blockers,
    warnings,
    metrics: {
      gfa, footprintSqFt, parkingSqFt, impervSqFt, coverageRatio,
      requiredStalls, parcelDepthFt, parcelWidthFt,
      frontDepthNeed, frontWidthNeed, sideDepthNeed, sideWidthNeed,
      requiredBasinSqFt: reqBasin, availBasinSqFt: availBasin,
    },
  };
}
