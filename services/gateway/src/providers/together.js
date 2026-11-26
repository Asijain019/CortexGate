import { createOpenAICompatAdapter } from './openaiCompat.js';

// Together AI. The "-Free" Llama endpoint costs nothing (rate-limited); other models are paid.
const M = 1_000_000;
export const PRICING = {
  'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free': { prompt: 0, completion: 0 },
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': { prompt: 0.88 / M, completion: 0.88 / M },
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo': { prompt: 0.18 / M, completion: 0.18 / M }
};

const adapter = createOpenAICompatAdapter({
  name: 'together', label: 'Together AI',
  url: 'https://api.together.xyz/v1/chat/completions',
  keyEnv: ['TOGETHER_API_KEY'], modelEnv: 'TOGETHER_MODEL',
  defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
  pricing: PRICING
});

export const { sendChatCompletion, calculateCost, isConfigured, defaultModel } = adapter;
