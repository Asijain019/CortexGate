import { createOpenAICompatAdapter } from './openaiCompat.js';

// Hugging Face Inference Providers router, OpenAI-compatible endpoint.
const adapter = createOpenAICompatAdapter({
  name: 'huggingface', label: 'Hugging Face',
  url: 'https://router.huggingface.co/v1/chat/completions',
  keyEnv: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'], modelEnv: 'HUGGINGFACE_MODEL',
  defaultModel: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B'
});

export const { sendChatCompletion, calculateCost, isConfigured } = adapter;
