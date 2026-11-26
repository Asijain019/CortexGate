import { createOpenAICompatAdapter } from './openaiCompat.js';

const FREE = { prompt: 0, completion: 0 };
export const PRICING = {
  'liquid/lfm-3-1.7b:free': FREE,
  'google/gemma-4-26b-a4b-it:free': FREE,
  'nvidia/nemotron-3.5-lightning:free': FREE,
  'meta-llama/llama-3.3-70b-instruct:free': FREE,
  'deepseek/deepseek-r1:free': FREE,
  'openrouter/free': FREE
};

const adapter = createOpenAICompatAdapter({
  name: 'openrouter', label: 'OpenRouter',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  keyEnv: ['OPENROUTER_API_KEY', 'OPENAI_API_KEY'], modelEnv: 'OPENROUTER_MODEL',
  defaultModel: 'liquid/lfm-3-1.7b:free',
  pricing: PRICING,
  headers: { 'HTTP-Referer': 'https://cortexgate.ai', 'X-Title': 'CortexGate' }
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
