import { msg, t } from '../../i18n/index.js';

/**
 * Fork-only: the Transit row's ESTIMATED pill. Estimated vehicles (registry
 * rows with `estimate`, docs/plans/transit-estimated-positions.md) are
 * positions worked out from times, not reported; a reader may want only the
 * reported ones. The pill shows while an estimated feed covers the view.
 */
export const TRANSIT_DEFAULT_PARAMS = Object.freeze({ estimated: true });

const ESTIMATED_CHIP = Object.freeze({
  label: msg('ESTIMATED'),
  title: msg('Vehicles placed from arrival predictions, not reported'),
});

/**
 * The ESTIMATED pill's params and row controls. The panel is repainted
 * through the `panel.invalidate()` handle the layer gets at init.
 * @param {object} context
 * @returns {object}
 */
export function createControls({ state, parts }) {
  const methods = {
    /**
     * `{estimated}`: whether estimated feeds are polled and drawn. Turning
     * it off drops their vehicles at once; on, they come back on the next
     * proximity check.
     */
    setParams(params = {}) {
      if (params.estimated === undefined) return true;
      const next = params.estimated !== false;
      if (next === state._showEstimated) return true;
      state._showEstimated = next;
      if (state._enabled) parts.viewport.runProximityCheck();
      state._panel?.invalidate();
      return true;
    },

    getParams() {
      return { estimated: state._showEstimated };
    },

    getRowControls() {
      if (!state._estimatedInRange) return { chips: [], legend: [] };
      const active = state._showEstimated;
      return {
        chips: [
          {
            id: 'estimated',
            label: t(ESTIMATED_CHIP.label),
            title: t(ESTIMATED_CHIP.title),
            active,
            state: active ? 'active' : 'idle',
            params: { estimated: !active },
          },
        ],
        legend: [],
      };
    },
  };
  return { methods };
}
