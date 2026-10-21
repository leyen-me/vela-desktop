import { INITIAL_BARS } from './provider.ts';
import type { JsonObject } from './types.ts';

export const PERSIST_KEY = 'vela-client-longbridge';
export const TIMEFRAME_FAVORITES = ['1', '5', '15', '60', '240', 'D', 'W', 'M'];
// Indicators every chart starts with. Volume is a native study; the other is the
// manifest name served by /api/v1/indicators.json.
export const DEFAULT_STUDIES = { native: 'volume', manifest: 'Smart Money Concepts' };
// Bump the version to re-apply the defaults to workspaces saved before this change.
const DEFAULTS_FLAG = 'host.defaultIndicators';
const DEFAULTS_VERSION = 2;
// The catalogue title differs from the name the script declares; a ledger entry must
// carry the declared one.
const LEGACY_STUDY_NAMES = ['Smart Money Concepts (SMC)'];

export function seedDefaultStudies(doc: JsonObject): JsonObject {
  const ext = doc.ext && typeof doc.ext === 'object' && !Array.isArray(doc.ext) ? doc.ext : {};
  if (ext[DEFAULTS_FLAG] === DEFAULTS_VERSION) return doc;
  if (Array.isArray(doc.charts)) {
    for (const chart of doc.charts) {
      if (!chart || typeof chart !== 'object') continue;
      const current = chart.indicators;
      const natives = Array.isArray(current?.natives) ? [...current.natives] : [];
      const manifest = Array.isArray(current?.manifest)
        ? current.manifest.filter((e: any) => !LEGACY_STUDY_NAMES.includes(typeof e === 'string' ? e : e?.name))
        : [];
      const typeOf = (e: any) => (typeof e === 'string' ? e : e?.type);
      const nameOf = (e: any) => (typeof e === 'string' ? e : e?.name);
      if (!natives.some((e: any) => typeOf(e) === DEFAULT_STUDIES.native)) natives.push(DEFAULT_STUDIES.native);
      if (!manifest.some((e: any) => nameOf(e) === DEFAULT_STUDIES.manifest)) manifest.push(DEFAULT_STUDIES.manifest);
      chart.indicators = { manifest, natives };
    }
  }
  doc.ext = { ...ext, [DEFAULTS_FLAG]: DEFAULTS_VERSION };
  return doc;
}

// Display timezone for the axis / bottom bar (IANA). The persisted workspace doc
// carries its own `timezone`, so we force it here too.
export const TIMEZONE = 'America/New_York';

// Vela draws the favorite timeframes as one-click switch chips in the topbar
// (and stars in the dropdown). The set only comes from the PERSISTED state, so
// we seed/merge it here — otherwise the topbar hides every timeframe behind the
// dropdown menu.
export const storage = {
  get(key: string): string | null {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (key !== PERSIST_KEY) return raw;
    if (!raw) {
      const fresh = seedDefaultStudies({
        version: 1, layout: '1', timezone: TIMEZONE, timeframeFavorites: TIMEFRAME_FAVORITES,
        ext: { 'host.agentPanelSeen': true },
      });
      fresh.panels = { open: 'agent' };
      return JSON.stringify(fresh);
    }
    try {
      const doc: JsonObject = JSON.parse(raw);
      doc.timezone = TIMEZONE;
      if (!Array.isArray(doc.timeframeFavorites) || doc.timeframeFavorites.length === 0) {
        doc.timeframeFavorites = TIMEFRAME_FAVORITES;
      }
      if (Array.isArray(doc.charts)) {
        for (const c of doc.charts) {
          // Every boot starts from the small window; scrolling grows it on demand.
          c.bars = INITIAL_BARS;
        }
      }
      const seeded = seedDefaultStudies(doc);
      const ext = seeded.ext && typeof seeded.ext === 'object' && !Array.isArray(seeded.ext) ? seeded.ext : {};
      if (ext['host.agentPanelSeen'] !== true) {
        // Show the agent column once for workspaces saved before it existed; closing it
        // later persists that choice (the marker stays, `open` does not).
        seeded.panels = { ...(seeded.panels || {}), open: 'agent' };
        seeded.ext = { ...ext, 'host.agentPanelSeen': true };
      }
      return JSON.stringify(seeded);
    } catch {
      return raw;
    }
  },
  set(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* storage may be unavailable */ } },
  remove(key: string) { try { localStorage.removeItem(key); } catch { /* storage may be unavailable */ } },
};
