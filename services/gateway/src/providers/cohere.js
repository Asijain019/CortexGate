import { createOpenAICompatAdapter } from './openaiCompat.js';

// Cohere (trial key) via its OpenAI-compatibility endpoint.
const adapter = createOpenAICompatAdapter({
  name: 'cohere', label: 'Cohere',
  url: 'https://api.cohere.ai/compatibility/v1/chat/completions',
  keyEnv: ['COHERE_API_KEY'], modelEnv: 'COHERE_MODEL', defaultModel: 'command-r7b-12-2024'
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
