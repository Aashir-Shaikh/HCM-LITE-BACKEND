const mongoose = require('mongoose');
const config = require('../config');

let memServer = null;

mongoose.set('strictQuery', true);

async function connect(retries = 3, delay = 2000) {
  let uri = config.mongoUri;
  if (!uri) {
    if (!config.mongoInMemory) {
      throw new Error('MONGODB_URI is not set. Put your hosted MongoDB connection string in backend/.env (see .env.example).');
    }
    // Test-suite only: throw-away in-memory MongoDB (dev dependency)
    const { MongoMemoryServer } = require('mongodb-memory-server');
    memServer = await MongoMemoryServer.create();
    uri = memServer.getUri();
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await mongoose.connect(uri, { dbName: config.mongoDb, serverSelectionTimeoutMS: 15000 });
      break;
    } catch (e) {
      if (attempt === retries) {
        throw new Error(`Could not connect to MongoDB (${e.message}). Check MONGODB_URI, the DB user/password, and that your IP / 0.0.0.0/0 is allowed in Atlas Network Access.`);
      }
      console.warn(`[db] Connection attempt ${attempt} failed (${e.message}). Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  const models = require('./models');
  // Build indexes (unique constraints are part of the business rules)
  await Promise.all(
    Object.values(models.all).map((m) =>
      m.init().catch((err) => {
        console.warn(`[db] Warning: Index sync for model '${m.modelName}' failed (${err.message}). Continuing...`);
      })
    )
  );
  await models.ensureSettings();
}

async function close() {
  await mongoose.disconnect();
  if (memServer) await memServer.stop();
}

const kind = () => (memServer ? 'mongodb (in-memory test)' : 'mongodb');
const host = () => (mongoose.connection.host || '').replace(/^.*@/, '');

module.exports = { connect, close, kind, host, mongoose };
