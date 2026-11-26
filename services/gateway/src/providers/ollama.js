import { createOpenAICompatAdapter } from './openaiCompat.js';

// Local Ollama (no key). Enabled when OLLAMA_BASE_URL is set or OLLAMA_ENABLED=true.
// CPU inference is slow, so dispatch uses OLLAMA_TIMEOUT_MS (default 30000) as
// this provider's per-attempt timeout instead of PROVIDER_TIMEOUT_MS.
// OLLAMA_API_KEY (or a dashboard key) is sent as a Bearer token if present, for
// remote/proxied Ollama servers; it is never required.
const baseUrl = () => (process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');

const adapter = createOpenAICompatAdapter({
  name: 'ollama', label: 'Ollama',
  url: () => `${baseUrl()}/chat/completions`,
  keyEnv: [], optionalKeyEnv: ['OLLAMA_API_KEY'], modelEnv: 'OLLAMA_MODEL', defaultModel: 'qwen2.5:0.5b',
  configEnv: 'OLLAMA_BASE_URL or OLLAMA_ENABLED=true',
  isConfigured: () => Boolean(process.env.OLLAMA_BASE_URL?.trim()) ||
    String(process.env.OLLAMA_ENABLED || '').toLowerCase() === 'true',
  timeoutMs: () => parseInt(process.env.OLLAMA_TIMEOUT_MS || '30000', 10)
});

export const { sendChatCompletion, calculateCost, isConfigured, timeoutMs } = adapter;
