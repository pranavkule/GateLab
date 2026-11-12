require('dotenv').config();
const mongoose = require('mongoose');

async function connectDb(uri) {
  const mongoUri = uri || process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27019/edgegate';
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, disconnectDb, mongoose };
