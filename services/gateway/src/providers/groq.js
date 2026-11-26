import { createOpenAICompatAdapter } from './openaiCompat.js';

// Pricing per token in USD (list price per 1M tokens / 1e6)
export const PRICING = {
  'openai/gpt-oss-20b': { prompt: 0.075 / 1_000_000, completion: 0.30 / 1_000_000 },
  'openai/gpt-oss-120b': { prompt: 0.15 / 1_000_000, completion: 0.60 / 1_000_000 },
  'qwen/qwen3.8-27b': { prompt: 0.10 / 1_000_000, completion: 0.40 / 1_000_000 }
};

const adapter = createOpenAICompatAdapter({
  name: 'groq', label: 'Groq',
  url: 'https://api.groq.com/openai/v1/chat/completions',
  keyEnv: ['GROQ_API_KEY'], modelEnv: 'GROQ_MODEL', defaultModel: 'openai/gpt-oss-20b',
  pricing: PRICING
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
