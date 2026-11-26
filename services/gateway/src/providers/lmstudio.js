import { createOpenAICompatAdapter } from './openaiCompat.js';

// LM Studio local server (OpenAI-compatible, free, runs on your machine).
// Enabled only when LMSTUDIO_BASE_URL is set or LMSTUDIO_ENABLED=true.
// LMSTUDIO_MODEL should name a model loaded in LM Studio; local inference is slow,
// so LMSTUDIO_TIMEOUT_MS (default 30000) is used as the per-attempt timeout.
const baseUrl = () => (process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');

const adapter = createOpenAICompatAdapter({
  name: 'lmstudio', label: 'LM Studio',
  url: () => `${baseUrl()}/chat/completions`,
  keyEnv: [], optionalKeyEnv: ['LMSTUDIO_API_KEY'], modelEnv: 'LMSTUDIO_MODEL', defaultModel: 'local-model',
  configEnv: 'LMSTUDIO_BASE_URL or LMSTUDIO_ENABLED=true',
  isConfigured: () => Boolean(process.env.LMSTUDIO_BASE_URL?.trim()) ||
    String(process.env.LMSTUDIO_ENABLED || '').toLowerCase() === 'true',
  timeoutMs: () => parseInt(process.env.LMSTUDIO_TIMEOUT_MS || '30000', 10)
});

export const { sendChatCompletion, calculateCost, isConfigured, timeoutMs, defaultModel } = adapter;
