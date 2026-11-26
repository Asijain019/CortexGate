import { createOpenAICompatAdapter } from './openaiCompat.js';
import { getProviderKey, getProviderAccountId } from './keyStore.js';

// Cloudflare Workers AI (free daily allocation). Needs the token and the account id;
// both may come from the dashboard (encrypted store) or env.
const accountId = () => getProviderAccountId('cloudflare', ['CLOUDFLARE_ACCOUNT_ID']);

const adapter = createOpenAICompatAdapter({
  name: 'cloudflare', label: 'Cloudflare Workers AI',
  url: () => `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId())}/ai/v1/chat/completions`,
  keyEnv: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'], modelEnv: 'CLOUDFLARE_MODEL',
  defaultModel: '@cf/meta/llama-3.1-8b-instruct',
  configEnv: 'CLOUDFLARE_ACCOUNT_ID',
  isConfigured: () => Boolean(getProviderKey(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY'], 'cloudflare') && accountId())
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
