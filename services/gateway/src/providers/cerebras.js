import { createOpenAICompatAdapter } from './openaiCompat.js';

// Cerebras Inference (free tier).
const adapter = createOpenAICompatAdapter({
  name: 'cerebras', label: 'Cerebras',
  url: 'https://api.cerebras.ai/v1/chat/completions',
  keyEnv: ['CEREBRAS_API_KEY'], modelEnv: 'CEREBRAS_MODEL', defaultModel: 'llama3.1-8b'
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
