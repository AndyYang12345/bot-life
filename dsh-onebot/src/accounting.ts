const fields = ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'] as const;
/** DSH counters are disjoint: cached input must not be counted again as uncached input. */
export function modelUsage(data: Record<string, unknown>, provider: string, model: string): Record<string, unknown> | undefined {
  const raw = data.usage as Record<string, unknown> | undefined;
  if (!raw || !Number.isSafeInteger(raw.inputTokens) || !Number.isSafeInteger(raw.outputTokens)) return undefined;
  const usage: Record<string, number> = {};
  for (const name of fields) {
    const count = raw[name];
    if (count !== undefined) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
      usage[name] = count;
    }
  }
  return { provider, model, credentialLabel: 'qqbot-independent', turn: data.turn, step: data.step, usage };
}
