const crypto = require('crypto');
const path = require('path');

// Load backend/.env if present (Node 20.12+); real environment variables (Render) always win
try {
  process.loadEnvFile(path.resolve(__dirname, '..', '.env'));
} catch {
  /* no .env file: fine in production */
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set - using a random secret (tokens reset on restart)');
}

// Any OpenAI-compatible chat API with tool calling. Pick one with AI_PROVIDER, or set AI_BASE_URL + AI_MODEL.
const AI_PRESETS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'poolside/laguna-s-2.1:free,google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,openrouter/free' },
};

module.exports = {
  isProd,
  port: Number(env.PORT) || 4000,
  jwtSecret,
  jwtExpiresIn: env.JWT_EXPIRES_IN || '12h',
  // Hosted MongoDB (Atlas etc.). Required; only the test-suite may use an in-memory server.
  mongoUri: env.MONGODB_URI || '',
  mongoDb: env.MONGODB_DB || 'hcm_lite',
  mongoInMemory: env.MONGO_IN_MEMORY === '1',
  corsOrigins: (env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  bootstrap: {
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    adminName: env.ADMIN_NAME || 'System Admin',
    companyName: env.COMPANY_NAME || '',
  },
  ai: {
    apiKey: env.AI_API_KEY || '',
    baseUrl: (env.AI_BASE_URL || AI_PRESETS[(env.AI_PROVIDER || 'groq').toLowerCase()]?.baseUrl || AI_PRESETS.groq.baseUrl).replace(/\/$/, ''),
    model: env.AI_MODEL || AI_PRESETS[(env.AI_PROVIDER || 'groq').toLowerCase()]?.model || AI_PRESETS.groq.model,
    timeoutMs: Number(env.AI_TIMEOUT_MS) || 15000,
    hourlyLimit: Number(env.AI_HOURLY_LIMIT) || 20,
  },
};
