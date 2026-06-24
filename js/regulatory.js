// regulatory.js — Hard feasibility gates checked after layout realization, before scoring.
// Pure, deterministic, never throws. turf.* is a CDN global on the main thread and is
// spread into a mutable plain object in the worker — no ESM turf import here.
//
// Architecture: a RULE_CHECKERS registry keyed by rule name. Each checker is
// (layout, ctx, params) => { detail } | null  (null = passes).
// Adding a new use type means registering new checker names and adding them to that
// profile's regConfig.rules — the checkGates loop never changes.

import { buildLocalFrame, feetToLocal, buildingLocalBounds } from './arrange.js';

const SQFT_PER_SQM = 10.7639;

// ---------------------------------------------------------------------------
// Shared-quantity context — computed once, passed to all checkers
// ---------------------------------------------------------------------------

function deriveContext(layout, parcelFt, parcelAreaSqFt, frontage) {
  const gfa      = layout.buildings.reduce((s, b) => s + b.length_ft * b.width_ft, 0);
  const footprint = gfa; // rectangular footprints → footprint === gfa

  const parkingSqFt  = layout.parking_areas.reduce((s, p) => s + turf.area(p) * SQFT_PER_SQM, 0);
  const drivewaySqFt = layout.driveways.reduce((s, d) => s + turf.area(d) * SQFT_PER_SQM, 0);
  const imperv = footprint + parkingSqFt + drivewaySqFt;

  const stalls = layout.parking_areas.reduce((s, p) => s + (p.properties?.stall_count ?? 0), 0);
  const basin  = layout.detention_pond ? turf.area(layout.detention_pond) * SQFT_PER_SQM : 0;

  const frame     = buildLocalFrame(frontage);
  const localPts  = parcelFt.map(p => feetToLocal(p, frame));
  const vFront    = Math.min(...localPts.map(p => p.v));
  const parcelVMax = Math.max(...localPts.map(p => p.v));
  const parcelUMin = Math.min(...localPts.map(p => p.u));
  const parcelUMax = Math.max(...localPts.map(p => p.u));

  return {
    gfa, footprint, parkingSqFt, drivewaySqFt, imperv,
    stalls, basin, parcelAreaSqFt, frame,
    vFront, parcelVMax, parcelUMin, parcelUMax,
  };
}

// ---------------------------------------------------------------------------
// Rule checker registry
// ---------------------------------------------------------------------------

const RULE_CHECKERS = {
  parkingRatioGFA(layout, ctx, p) {
    if (ctx.gfa === 0) return null;
    const required = Math.ceil(ctx.gfa / 1000 * p.per1000);
    if (ctx.stalls >= required) return null;
    return { detail: `parking ${ctx.stalls} stalls < required ${required} (${p.per1000}/1,000 sq ft GFA)` };
  },

  lotCoverage(layout, ctx, p) {
    const ratio = ctx.imperv / ctx.parcelAreaSqFt;
    if (ratio <= p.max) return null;
    return { detail: `lot coverage ${(ratio * 100).toFixed(1)}% > max ${(p.max * 100).toFixed(0)}%` };
  },

  buildingCoverage(layout, ctx, p) {
    const ratio = ctx.footprint / ctx.parcelAreaSqFt;
    if (ratio <= p.max) return null;
    return { detail: `building coverage ${(ratio * 100).toFixed(1)}% > max ${(p.max * 100).toFixed(0)}%` };
  },

  setbacks(layout, ctx, p) {
    const { frame, vFront, parcelVMax, parcelUMin, parcelUMax } = ctx;
    for (const b of layout.buildings) {
      const lb = buildingLocalBounds(b, frame);
      const frontSB = lb.vMin - vFront;
      const rearSB  = parcelVMax - lb.vMax;
      const sideSB  = Math.min(lb.uMin - parcelUMin, parcelUMax - lb.uMax);
      if (frontSB < p.frontFt)
        return { detail: `front setback ${Math.round(frontSB)} ft < ${p.frontFt} ft (bldg ${b.label ?? '?'})` };
      if (rearSB < p.rearFt)
        return { detail: `rear setback ${Math.round(rearSB)} ft < ${p.rearFt} ft (bldg ${b.label ?? '?'})` };
      if (sideSB < p.sideFt)
        return { detail: `side setback ${Math.round(sideSB)} ft < ${p.sideFt} ft (bldg ${b.label ?? '?'})` };
    }
    return null;
  },

  // widthFt is attached by realizeDriveway in arrange.js; falls back to 0 when absent
  // (legacy solver path does not attach it — those driveways pass this check if enabled:false).
  aisleWidth(layout, ctx, p) {
    for (const d of layout.driveways) {
      const w = d.properties?.widthFt ?? 0;
      if (w > 0 && w < p.minFt)
        return { detail: `drive aisle ${w} ft < minimum ${p.minFt} ft` };
    }
    return null;
  },

  // Fire access needs at least one lane wide enough for a fire apparatus.
  fireLane(layout, ctx, p) {
    if (layout.driveways.length === 0) return null;
    const widths = layout.driveways.map(d => d.properties?.widthFt ?? 0).filter(w => w > 0);
    if (widths.length === 0) return null; // widthFt absent — can't check, skip
    const widest = Math.max(...widths);
    if (widest >= p.minFt) return null;
    return { detail: `widest lane ${widest} ft < fire lane minimum ${p.minFt} ft` };
  },

  detention(layout, ctx, p) {
    const required = ctx.imperv * p.areaPerImpervFt;
    if (required === 0) return null;
    if (ctx.basin >= required) return null;
    const approxNote = p.approximate ? ' [area-proportional approx]' : '';
    return {
      detail: `basin ${Math.round(ctx.basin).toLocaleString()} sq ft < required ` +
              `${Math.round(required).toLocaleString()} sq ft (${p.areaPerImpervFt} × impervious)${approxNote}`,
    };
  },
};

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function checkGates(layout, reqs, parcelFt, parcelAreaSqFt, frontage, profile) {
  const cfg = profile.regConfig;
  if (!cfg || !cfg.rules) return { pass: true, violations: [] };

  const ctx = deriveContext(layout, parcelFt, parcelAreaSqFt, frontage);
  const violations = [];

  for (const [name, rule] of Object.entries(cfg.rules)) {
    if (!rule.enabled) continue;
    const checker = RULE_CHECKERS[name];
    if (!checker) {
      violations.push({ rule: name, detail: 'no checker registered', severity: 'soft' });
      continue;
    }
    const v = checker(layout, ctx, rule);
    if (v) violations.push({ ...v, rule: name, severity: rule.severity });
  }

  const hardFail = violations.some(v => v.severity === 'hard');
  return { pass: !hardFail, violations };
}
