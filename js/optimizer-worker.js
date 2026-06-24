// Module worker for optimizeArrangement — runs the Phase 1+2 search off the main thread.
//
// Turf must be imported as ESM here (importScripts is not available in module workers).
// We spread the frozen module namespace into a mutable plain object so that
// optimizeArrangement can monkey-patch turf.union / .difference / .intersect during search.
import * as turfNS from 'https://esm.sh/@turf/turf@6.5.0';
globalThis.turf = { ...turfNS };

import { optimizeArrangement } from './optimize.js';

self.onmessage = ({ data }) => {
  const { parcelLatLng, reqs, frontage, profile, aiSeeds = [], road = null } = data;

  const { ranked, totalTried, gatedOut, truncated } = optimizeArrangement(
    parcelLatLng, reqs, frontage, profile,
    (progress) => self.postMessage({ type: 'progress', ...progress }),
    aiSeeds,
    road,
  );

  self.postMessage({ type: 'done', ranked, totalTried, gatedOut, truncated });
};
