import { createOpenAICompatAdapter } from './openaiCompat.js';

export const PRICING = {
  'mistral-small-latest': { prompt: 0.20 / 1_000_000, completion: 0.60 / 1_000_000 },
  'open-mistral-7b': { prompt: 0.25 / 1_000_000, completion: 0.25 / 1_000_000 }
};

const adapter = createOpenAICompatAdapter({
  name: 'mistral', label: 'Mistral',
  url: 'https://api.mistral.ai/v1/chat/completions',
  keyEnv: ['MISTRAL_API_KEY'], modelEnv: 'MISTRAL_MODEL', defaultModel: 'mistral-small-latest',
  pricing: PRICING
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
