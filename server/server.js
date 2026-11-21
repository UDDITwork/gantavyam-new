// server.js
const express = require('express');
const cors = require('cors');
const mongoose = require('./db');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');
const { printDriverStats } = require('./controllers/driverController');
const http = require('http');
const { initializeSocket, getServices } = require('./socket');
const config = require('./config/config');
const Admin = require('./models/Admin');
const { createContextLogger } = require('./config/logger');
const requestLogger = require('./middleware/requestLogger');
const { seedMetroStations } = require('./utils/seedMetroStations');

const logger = createContextLogger('Server');

console.log('Current working directory:', process.cwd());
console.log('server.js directory:', __dirname);
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Initialize express app
const app = express();

// Middleware
app.use(cors({
  origin: config.allowedOrigins,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Add request logging middleware
app.use(requestLogger);

// Set static folder for serving uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Log file access for debugging
app.use('/uploads', (req, res, next) => {
  console.log('[File Access]', req.url);
  next();
});

// Connect to the database (Turso / libSQL).
// TURSO_DATABASE_URL is libsql://<db>.turso.io in production, or file:./data/gantavyam.db for local development.
const databaseOptions = {
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
};

mongoose.connect(databaseOptions)
.then(async () => {
  logger.info('Database connected successfully', {
    database: mongoose.connection.host // host only, never the auth token
  });

  // Sync User indexes so the sparse unique index on email is correct
  const User = require('./models/User');
  await User.syncIndexes();

  // Print database statistics on startup
  printDriverStats();
  // Ensure default admin exists
  await Admin.createDefaultAdmin();
  // Update existing admin permissions to match current role definitions
  await Admin.updateAdminPermissions();

  // Seed metro stations if not present
  try {
    const MetroStation = require('./models/MetroStation');
    const stationCount = await MetroStation.countDocuments();
    
    if (stationCount === 0) {
      logger.info('No metro stations found, seeding data...');
      await seedMetroStations();
      logger.info('Metro stations seeded successfully');
    } else {
      logger.info(`Metro stations already exist (${stationCount} stations)`);
    }
  } catch (error) {
    logger.error('Error checking/seeding metro stations:', error);
  }
  
  // Setup periodic database monitoring
  setInterval(async () => {
    await printDriverStats();
  }, 30 * 60 * 1000); // Every 30 minutes
})
.catch(err => {
  logger.error('Database connection error', {
    error: err.message,
    stack: err.stack
  });
  logger.error('Database connection failed - possible solutions:');
  logger.error('1. Check TURSO_DATABASE_URL (libsql://... or file:...) and TURSO_AUTH_TOKEN');
  logger.error('2. Check your internet connection');
  logger.error('3. Use a local file database for development: TURSO_DATABASE_URL=file:./data/gantavyam.db');

  // Don't exit immediately, allow for retry
  setTimeout(() => {
    logger.info('Retrying database connection...');
    mongoose.connect(databaseOptions)
      .then(() => logger.info('Database connected on retry'))
      .catch(() => {
        logger.error('Database retry failed. Exiting...');
        process.exit(1);
      });
  }, 5000);
});

// Define Routes
app.use('/api/drivers', require('./routes/drivers'));
app.use('/api/drivers', require('./routes/driverOnlineRequest')); // Driver online request system
app.use('/api/admin', require('./routes/admin'));
app.use('/api/admin/online-requests', require('./routes/admin/driverOnlineRequestRoutes')); // Admin online request management
app.use('/api/users', require('./routes/users'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/ride-requests', require('./routes/rideRequests'));
app.use('/api/ride-history', require('./routes/rideHistory'));
app.use('/api/fare', require('./routes/fareEstimation'));
app.use('/api/otp', require('./routes/otpVerification'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/uploads', require('./routes/uploads'));

// Basic route for API status
app.get('/', (req, res) => {
  res.send('API is running...');
});

// Health check (used by Cloud Run and uptime monitors)
app.get("/api/health", (req, res) => {
  const connected = mongoose.connection.readyState === 1;
  res.status(connected ? 200 : 503).json({ status: connected ? "ok" : "unavailable", database: connected ? "connected" : "disconnected" });
});

// Database monitoring route
app.get('/api/status', async (req, res) => {
  try {
    const Driver = mongoose.model('Driver');
    const totalDrivers = await Driver.countDocuments();
    const recentDrivers = await Driver.find()
      .sort({ registrationDate: -1 })
      .limit(5)
      .select('fullName mobileNo registrationDate');
    
    res.json({
      status: 'success',
      mongodb: {
        connected: mongoose.connection.readyState === 1,
        state: mongoose.STATES[mongoose.connection.readyState]
      },
      data: {
        totalDrivers,
        recentDrivers
      }
    });
  } catch (error) {
    console.error('Status API error:', error);
    res.status(500).json({
      status: 'error',
      error: 'Could not fetch database status'
    });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server Error:', err);
  res.status(500).json({
    success: false,
    error: 'Server error',
    message: err.message
  });
});

// Start server
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
// Initialize Socket.IO
initializeSocket(server);

// Initialize admin tools with services after socket initialization
try {
  const { initializeServices } = require('./routes/admin/rideManagementTools');
  const { enhancedNotificationService } = getServices();
  initializeServices(enhancedNotificationService);
  logger.info('✅ Admin ride management tools initialized successfully');
} catch (error) {
  logger.warn('⚠️ Failed to initialize admin tools:', error.message);
}

// Initialize disconnection monitor for handling stale driver connections
try {
  const disconnectionMonitor = require('./services/disconnectionMonitor');
  const { io } = getServices();
  disconnectionMonitor.setIO(io);
  disconnectionMonitor.start();
  logger.info('✅ Disconnection monitor started (30-min timeout for disconnected drivers)');
} catch (error) {
  logger.warn('⚠️ Failed to start disconnection monitor:', error.message);
}
server.listen(PORT, () => {
  logger.info('GANTAVYAM SERVER STARTED', {
    port: PORT,
    uploadsDirectory: uploadsDir,
    database: process.env.MONGO_URL?.replace(/:([^:@]{1,})@/, ':***@'), // Hide password in logs
    nodeEnv: process.env.NODE_ENV || 'development'
  });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  logger.error('Unhandled Promise Rejection', { 
    error: err.message, 
    stack: err.stack 
  });
  // Close server & exit process
  // server.close(() => process.exit(1));
});