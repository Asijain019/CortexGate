import { createOpenAICompatAdapter } from './openaiCompat.js';

// Cloudflare Workers AI (free daily allocation). Needs the token and the account id.
const adapter = createOpenAICompatAdapter({
  name: 'cloudflare', label: 'Cloudflare Workers AI',
  url: () => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID || '')}/ai/v1/chat/completions`,
  keyEnv: ['CLOUDFLARE_API_TOKEN'], modelEnv: 'CLOUDFLARE_MODEL',
  defaultModel: '@cf/meta/llama-3.1-8b-instruct',
  configEnv: 'CLOUDFLARE_ACCOUNT_ID',
  isConfigured: () => Boolean(process.env.CLOUDFLARE_API_TOKEN?.trim() && process.env.CLOUDFLARE_ACCOUNT_ID?.trim())
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
