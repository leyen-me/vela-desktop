/**
 * Pins the sampling temperature for every agent created by the Vela runtime.
 *
 * dsh exposes temperature only through the `agent/request` waterfall, so this
 * local plugin (mounted from the generated cordis patch) is the smallest seam
 * that keeps both live analysis and backtests on one sampling policy.
 */

export const name = 'vela-sampling';

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ temperature?: number }} [config]
 */
export function apply(ctx, config) {
  const temperature = config?.temperature;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) return;
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next();
      return { ...resolved, temperature };
    });
  });
}
