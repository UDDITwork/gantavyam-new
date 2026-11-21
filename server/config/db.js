const mongoose = require('../db');

// Connects to Turso / libSQL (or a local file database for development).
const connectDB = async () => {
  try {
    const conn = await mongoose.connect({
      url: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN
    });

    console.log(`Database connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
