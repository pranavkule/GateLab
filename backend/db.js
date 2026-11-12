require('dotenv').config();
const mongoose = require('mongoose');

async function connectDb(uri) {
  const mongoUri = uri || process.env.MONGO_URI || process.env.MONGODB_URI ||
    (process.env.NODE_ENV === 'production' ? null : 'mongodb://127.0.0.1:27019/edgegate');
  if (!mongoUri) {
    throw new Error('MONGO_URI is required in production');
  }
  if (process.env.NODE_ENV === 'production') {
    let parsed;
    try { parsed = new URL(mongoUri); } catch (_) {
      throw new Error('MONGO_URI must be a valid authenticated MongoDB connection URL in production');
    }
    if (!parsed.username || !parsed.password) {
      throw new Error('MONGO_URI must include MongoDB credentials in production');
    }
  }
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, disconnectDb, mongoose };
