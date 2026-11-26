import { createOpenAICompatAdapter } from './openaiCompat.js';

export const PRICING = {
  'gpt-oss-120b': { prompt: 0.15 / 1_000_000, completion: 0.60 / 1_000_000 },
  'Meta-Llama-3.1-8B-Instruct': { prompt: 0.10 / 1_000_000, completion: 0.20 / 1_000_000 },
  'Meta-Llama-3.3-70B-Instruct': { prompt: 0.60 / 1_000_000, completion: 1.20 / 1_000_000 }
};

const adapter = createOpenAICompatAdapter({
  name: 'sambanova', label: 'SambaNova',
  url: 'https://api.sambanova.ai/v1/chat/completions',
  keyEnv: ['SAMBANOVA_API_KEY'], modelEnv: 'SAMBANOVA_MODEL', defaultModel: 'gpt-oss-120b',
  pricing: PRICING
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
