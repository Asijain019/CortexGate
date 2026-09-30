## Progress Log

- Sep 30 - Gateway skeleton + Groq adapter working, /v1/chat/completions returns OpenAI-compatible responses
- Fixed Groq model config — account has a non-standard model catalog, gpt-oss-20b now in use, cost tracking verified against a live request.
- Sep 30 - Gemini provider adapter added, chat route updated to be provider-agnostic
- Sep 30 - Failover logic added to chat route with automatic retry on 5xx/429/timeout and provider logging
