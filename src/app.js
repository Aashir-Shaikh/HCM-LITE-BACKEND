const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const { authenticate } = require('./middleware/auth');
const { notFoundHandler, errorHandler } = require('./middleware/error');

// CORS_ORIGIN entries may be exact origins or wildcards such as https://*.vercel.app
const allowed = (origin) => {
  if (!origin) return true;
  
  // 1. Localhost allow karne ke liye (Development ke waqt)
  if (!config.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }

  // 2. Vercel ke subdomains allow karne ke liye (Wildcard support)
  // Yeh aapke har Vercel deploy URL (chahe main domain ho ya preview deployment) ko allow kar dega
  if (/^https:\/\/.*\.vercel\.app$/.test(origin)) {
    return true;
  }

  // 3. Agar aapka koi apna custom domain hai Vercel par, toh aap usay yahan direct bhi add kar sakte hain:
  if (origin === 'https://hcm-lite-frontend-seven.vercel.app') return true;

  return false;
};
  return config.corsOrigins.some((o) => {
    if (o === '*' || o === origin) return true;
    if (!o.includes('*')) return false;
    const re = new RegExp('^' + o.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]+') + '$');
    return re.test(origin);
  });
};

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render's proxy
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({
    origin(origin, cb) {
      // allow same-origin/no-origin (curl, health checks) and configured origins
      if (!origin || allowed(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition'],
  }));
  app.use(express.json({ limit: '3mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan(config.isProd ? 'combined' : 'dev'));

  app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
  app.get('/', (_req, res) => res.json({ name: 'HCM Lite API', docs: '/health, /api/*' }));

  const api = express.Router();
  api.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
  api.use(require('./routes/auth'));
  api.use(authenticate); // everything below requires a signed-in user
  api.use(require('./routes/org'));
  api.use(require('./routes/users'));
  api.use(require('./routes/employees'));
  api.use(require('./routes/attendance'));
  api.use(require('./routes/leave'));
  api.use(require('./routes/payroll'));
  api.use(require('./routes/misc'));
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
