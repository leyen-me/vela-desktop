// vela/workspace — the multi-chart shell: a grid of ChartCells with stable identities,
// one shared data feed, an active cell, resizable splitters, and a layout registry
// (`registerLayout`) plugins extend like every other Vela registry.
export { VelaWorkspace } from './VelaWorkspace';
export type { VelaWorkspaceOptions, WorkspaceEventMap, WorkspaceScriptRun } from './VelaWorkspace';
export { ChartCell } from './ChartCell';
export type { CellSeed, CellBoot, CellChartDefaults, PooledCellState, CellNativeInfo } from './ChartCell';
export type { WorkspaceWidgetContext } from './context';
export { WorkspaceReplay, barClose, lastOpenClosedBy } from './WorkspaceReplay';
export type { WorkspaceReplayEventMap, WorkspaceReplayStartOptions, WorkspaceReplayHost } from './WorkspaceReplay';
export {
    registerLayout,
    unregisterLayout,
    layoutDefinition,
    layouts,
    registerBuiltinLayouts,
    gridStyles,
    activeAfterLayout,
    layoutForGrid,
    ensureLayout,
    layoutShape,
    GRID_PICKER_MAX,
} from './layouts';
export type { LayoutDefinition, LayoutShape, TrackSizes } from './layouts';
export { evenTracks, resizeTracks, trackOffsets } from './splitters';
export { syncTargets, rangesWithin } from './sync';
export type { SyncKind, SyncSetting, SyncOptions } from './sync';
export { encodeState, decodeState, sanitizeState, memoryStorageAdapter } from './persist';
export type { WorkspaceState, CellState, ChartState, PanelsState, DrawingToolsState, WorkspaceStorage } from './persist';

// UI localisation (chrome strings; canvas text is out of scope).
export { setLocale, getLocale, t } from '../i18n';
export type { Locale } from '../i18n';

// Re-exported here so a workspace app can set renderer defaults (e.g. attribution)
// through the SAME module instance the workspace itself reads.
export { registerRendererDefaults, unregisterRendererDefaults, rendererDefaults } from '../core/renderer-defaults';

// Symbol ranking — re-exported so a workspace app can set it through the SAME
// module instance the symbol picker reads.
export { registerSymbolRanking } from '../widget/contributions';
export type { SymbolRankingHook } from '../widget/contributions';

// Legend-row actions — re-exported so a workspace app can register them through
// the SAME module instance the legend resolves.
export { registerLegendAction, unregisterLegendAction, legendActions } from '../widget/contributions';
export type { LegendActionDescriptor, LegendIndicatorInfo } from '../widget/contributions';
