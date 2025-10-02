const { MongoClient } = require('mongodb');

let db = null;
let client = null;

async function connectToDatabase() {
  if (db) return db;

  try {
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/ytdt-claims-pipeline';
    
    client = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
      minPoolSize: 2,
    });
    
    await client.connect();
    db = client.db();
    
    console.log('Connected to MongoDB');
    
    // Create indexes for better performance
    await createIndexes();
    
    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

async function createIndexes() {
  try {
    // Index for pipeline runs
    await db.collection('pipeline_runs').createIndex({ startTime: -1 });
    await db.collection('pipeline_runs').createIndex({ status: 1 });
    
    console.log('Database indexes created');
  } catch (error) {
    console.error('Index creation error:', error);
  }
}

async function closeConnection() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('MongoDB connection closed');
  }
}

function getDatabase() {
  if (!db) {
    throw new Error('Database not connected. Call connectToDatabase() first.');
  }
  return db;
}

module.exports = {
  connectToDatabase,
  closeConnection,
  getDatabase
};