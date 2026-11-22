// server/socket.js
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const config = require('./config/config');
const RideRequest = require('./models/RideRequest');
const Driver = require('./models/Driver');
const User = require('./models/User');
const MetroStation = require('./models/MetroStation');
const Admin = require('./models/Admin');
const { generateRideId, generateRideOTPs, verifyOTP } = require('./utils/otpUtils');
const { logRideEvent, logUserAction, logDriverAction, logError, logStatusTransition, logSocketDelivery } = require('./utils/rideLogger');
const { calculateFareEstimates } = require('./utils/fareCalculator');
const { generateQueueNumber, updateQueuePosition, removeFromQueue } = require('./utils/queueManager');
const RideLifecycleService = require('./services/rideLifecycle');
const EnhancedNotificationService = require('./utils/enhancedNotification');
const RideCompletionService = require('./utils/rideCompletionService');
const { buildDriverRidePayload, markDriverNotified, collectDeliverableRequests } = require('./utils/driverRequestDelivery');
const { isExecutive, podOf, podRoomName, EXECUTIVES_ROOM } = require('./utils/podScope');
const { toAdmins, toAdminsAndExecutives } = require('./utils/adminRealtime');

let io;
let enhancedNotificationService;
let rideCompletionService;

// Track connected clients by user ID
const connectedClients = new Map();

// Sends a driver's socket every request assigned to that driver that should be on their screen: requests that
// never reached them (with a fresh response window) and requests still counting down. Called when the driver
// connects, reconnects or asks for a refresh, so a missed push is never lost.
// `onlyUnconfirmed` skips requests this socket has already acknowledged (used for the automatic delivery that
// follows a connection, so it does not repeat what the driver's app already showed).
const deliverPendingRequests = async (socket, reason, { onlyUnconfirmed = false } = {}) => {
  try {
    if (!socket.user || socket.user.role !== 'driver' || !socket.connected) return 0;
    if (!socket.confirmedRequestIds) socket.confirmedRequestIds = new Set();

    const rides = await collectDeliverableRequests(socket.user._id);
    let sent = 0;
    for (const ride of rides) {
      const id = String(ride._id);
      if (onlyUnconfirmed && socket.confirmedRequestIds.has(id)) continue;

      socket.emit('newRideRequest', buildDriverRidePayload(ride), () => {
        socket.confirmedRequestIds.add(id);
        markDriverNotified(ride._id);
      });
      sent += 1;
      console.log(`📬 [pending delivery: ${reason}] sent request ${ride.bookingId} to driver ${socket.user._id}`);
    }
    return sent;
  } catch (error) {
    console.error('❌ [pending delivery] failed:', error.message);
    return 0;
  }
};

// Broadcast state change to all relevant clients
const broadcastStateChange = (eventType, data) => {
  console.log(`📢 Broadcasting ${eventType} to all clients:`, data);
  
  // Notify all admins
  notifyAdmins(eventType, data);
  
  // Notify specific driver if applicable
  if (data.driverId) {
    const driverSocket = connectedClients.get(data.driverId);
    if (driverSocket) {
      // Send personalized event to driver
      driverSocket.emit(`driver${eventType.charAt(0).toUpperCase()}${eventType.slice(1)}`, data);
    }
  }
  
  // Notify all drivers about queue changes (with stability checks)
  if (eventType === 'queuePositionsUpdated') {
    console.log(`📡 Broadcasting queue position updates to ${connectedClients.size} connected clients...`);

    connectedClients.forEach((socket, userId) => {
      if (socket.user && socket.user.role === 'driver') {
        const driverUpdate = data.queueUpdates?.find(q => q._id?.toString() === userId);
        if (driverUpdate) {
          // Stability check: Only broadcast if position actually changed significantly
          const lastBroadcastPosition = socket.lastBroadcastPosition || null;
          const newPosition = driverUpdate.queuePosition;

          // Skip broadcast if position hasn't changed
          if (lastBroadcastPosition === newPosition) {
            console.log(`📋 Skipping broadcast to ${socket.user.fullName} - position unchanged (${newPosition})`);
            return;
          }

          // Add validation for reasonable position changes
          if (lastBroadcastPosition !== null && newPosition !== null) {
            const positionChange = Math.abs(newPosition - lastBroadcastPosition);

            // Warn about large position changes (potential queue corruption)
            if (positionChange > 10) {
              console.warn(`⚠️ Large position change detected for ${socket.user.fullName}: ${lastBroadcastPosition} -> ${newPosition} (change: ${positionChange})`);
              console.warn(`📋 Action: ${data.action}, Timestamp: ${data.timestamp}`);
            }
          }

          console.log(`📡 Broadcasting to ${socket.user.fullName}: position ${lastBroadcastPosition || 'unknown'} -> ${newPosition}`);

          socket.emit('queuePositionUpdated', {
            queuePosition: newPosition,
            totalOnline: data.totalOnline,
            timestamp: data.timestamp,
            action: data.action,
            previousPosition: lastBroadcastPosition
          });

          // Store the last broadcast position for stability checks
          socket.lastBroadcastPosition = newPosition;
        }
      }
    });

    console.log('📡 Queue position broadcast completed');
  }
};

// Function to update queue after driver goes offline (proper queue shifting)
const updateQueueAfterDriverRemoval = async (removedDriverId) => {
  try {
    console.log(`🔄 Updating queue after driver ${removedDriverId} removal...`);
    
    // Get the removed driver's position
    const removedDriver = await Driver.findById(removedDriverId);
    if (!removedDriver || !removedDriver.queuePosition) {
      console.log('❌ Removed driver not found or had no queue position');
      return await getCompleteQueueState();
    }
    
    const removedPosition = removedDriver.queuePosition;
    console.log(`📋 Removed driver was at position ${removedPosition}`);
    
    // Clear the removed driver's queue position
    await Driver.findByIdAndUpdate(removedDriverId, {
      queuePosition: null
    });
    
    // Find all drivers who were AFTER the removed driver (position > removedPosition)
    const driversToShift = await Driver.find({
      isOnline: true,
      isVerified: true,
      queuePosition: { $gt: removedPosition }
    }).sort({ queuePosition: 1 });
    
    console.log(`📋 Found ${driversToShift.length} drivers to shift up`);
    
    // Validate queue integrity and reorder if needed
    await validateQueueIntegrity();
    
    console.log(`✅ Queue reordered after driver removal - ${driversToShift.length} drivers repositioned`);
    
    // Get complete queue state for broadcasting
    const completeQueueState = await getCompleteQueueState();
    
    // Broadcast updated queue state to all clients
    broadcastStateChange('queuePositionsUpdated', {
      queueUpdates: completeQueueState,
      totalOnline: completeQueueState.length,
      timestamp: new Date().toISOString(),
      action: 'driver_removed',
      removedDriverId
    });
    
    console.log('📢 Queue positions broadcasted to all admins and individual drivers after driver removal');
    return completeQueueState;
    
  } catch (error) {
    console.error('❌ Error updating queue after driver removal:', error);
    return await getCompleteQueueState();
  }
};

// Function to update queue after driver goes online (proper queue insertion)
const updateQueueAfterDriverAddition = async (addedDriverId) => {
  try {
    console.log(`🔄 Updating queue after driver ${addedDriverId} addition...`);
    
    // Get the added driver
    const addedDriver = await Driver.findById(addedDriverId);
    if (!addedDriver || !addedDriver.isOnline) {
      console.log('❌ Added driver not found or not online');
      return await getCompleteQueueState();
    }
    
    // Get all current online drivers sorted by queue entry time (first-come-first-served)
    const onlineDrivers = await Driver.find({
      isOnline: true,
      isVerified: true,
      _id: { $ne: addedDriverId }
    }).sort({ queueEntryTime: 1 });
    
    // New driver gets the next position in sequence (first-come-first-served)
    const newPosition = onlineDrivers.length + 1;
    
    console.log(`📋 New driver will be assigned position ${newPosition} (${onlineDrivers.length} drivers already online)`);
    console.log(`📋 Queue entry time: ${addedDriver.queueEntryTime || addedDriver.lastActiveTime}`);
    
    // Set the new driver's position
    await Driver.findByIdAndUpdate(addedDriverId, {
      queuePosition: newPosition
    });
    
    console.log(`✅ Driver ${addedDriver.fullName} assigned position ${newPosition}`);
    
    // Validate queue integrity and reorder if needed
    await validateQueueIntegrity();
    
    // Get complete queue state for broadcasting
    const completeQueueState = await getCompleteQueueState();
    
    // Broadcast updated queue state to all clients
    broadcastStateChange('queuePositionsUpdated', {
      queueUpdates: completeQueueState,
      totalOnline: completeQueueState.length,
      timestamp: new Date().toISOString(),
      action: 'driver_added',
      addedDriverId
    });
    
    console.log('📢 Queue positions broadcasted to all admins and individual drivers after driver addition');
    return completeQueueState;
    
  } catch (error) {
    console.error('❌ Error updating queue after driver addition:', error);
    return await getCompleteQueueState();
  }
};

// Function to add driver back to queue at LAST position (after ride completion)
const addDriverBackToQueue = async (driverId, boothName) => {
  try {
    console.log(`🔄 Re-adding driver ${driverId} to queue at LAST position...`);

    // Count current online drivers in queue to get last position
    const onlineDriverCount = await Driver.countDocuments({
      isOnline: true,
      inQueue: true,
      isVerified: true,
      _id: { $ne: driverId } // Exclude this driver
    });

    const newPosition = onlineDriverCount + 1;
    const queueEntryTime = new Date();

    // Update driver with new queue position (at the END)
    const updatedDriver = await Driver.findByIdAndUpdate(driverId, {
      inQueue: true,
      queuePosition: newPosition,
      queueEntryTime: queueEntryTime,
      lastActiveTime: queueEntryTime
    }, { new: true });

    if (!updatedDriver) {
      console.error(`❌ Driver ${driverId} not found for re-queuing`);
      return null;
    }

    console.log(`✅ Driver ${updatedDriver.fullName} re-added to queue at position ${newPosition}`);

    // Get complete queue state
    const completeQueueState = await getCompleteQueueState();

    // Broadcast status change to all clients
    broadcastStateChange('driverStatusChanged', {
      driverId: updatedDriver._id,
      driverName: updatedDriver.fullName,
      isOnline: true,
      inQueue: true,
      queuePosition: newPosition,
      connectionStatus: updatedDriver.connectionStatus,
      currentPickupLocation: boothName || updatedDriver.currentMetroBooth,
      changedBy: 'system',
      reason: 'ride_completed_requeued',
      timestamp: new Date().toISOString()
    });

    // Also broadcast queue update
    broadcastStateChange('queuePositionsUpdated', {
      queueUpdates: completeQueueState,
      totalOnline: completeQueueState.length,
      timestamp: new Date().toISOString(),
      action: 'driver_requeued',
      requeuedDriverId: driverId.toString()
    });

    console.log(`📢 Driver ${updatedDriver.fullName} re-queue broadcasted - Position ${newPosition}`);
    return updatedDriver;

  } catch (error) {
    console.error('❌ Error re-adding driver to queue:', error);
    return null;
  }
};

// Function to validate queue integrity and fix any issues
const validateQueueIntegrity = async () => {
  try {
    console.log('🔍 Validating queue integrity...');

    const onlineDrivers = await Driver.find({
      isOnline: true,
      isVerified: true
    }).sort({
      queuePosition: 1  // Sort by current position first to check integrity
    });

    let hasCriticalIssues = false;
    const issues = [];
    const criticalIssues = [];

    // Check for duplicate positions (CRITICAL - must fix immediately)
    const positions = onlineDrivers.map(d => d.queuePosition).filter(p => p !== null);
    const duplicates = positions.filter((pos, index) => positions.indexOf(pos) !== index);
    if (duplicates.length > 0) {
      hasCriticalIssues = true;
      criticalIssues.push(`Duplicate queue positions: ${duplicates.join(', ')}`);
      console.log(`🚨 CRITICAL: Found duplicate positions that MUST be fixed immediately: ${duplicates.join(', ')}`);
    }

    // Check for drivers without queue entry time (CRITICAL - must fix)
    const driversWithoutEntryTime = onlineDrivers.filter(d => !d.queueEntryTime && d.queuePosition);
    if (driversWithoutEntryTime.length > 0) {
      console.log(`⚠️ Found ${driversWithoutEntryTime.length} drivers without queue entry time - setting now`);
      // Fix missing entry times without reordering
      await Promise.all(driversWithoutEntryTime.map(driver =>
        Driver.findByIdAndUpdate(driver._id, {
          queueEntryTime: driver.lastActiveTime || new Date()
        })
      ));
      issues.push(`Fixed ${driversWithoutEntryTime.length} drivers without queue entry time`);
    }

    // Check for missing positions (NON-CRITICAL - gaps are OK temporarily)
    const expectedPositions = Array.from({ length: onlineDrivers.length }, (_, i) => i + 1);
    const missingPositions = expectedPositions.filter(pos => !positions.includes(pos));
    if (missingPositions.length > 0) {
      issues.push(`Minor gaps in queue positions: ${missingPositions.join(', ')} (will auto-correct gradually)`);
      console.log(`📋 Non-critical queue gaps detected: ${missingPositions.join(', ')} - allowing natural correction`);
    }

    // Only reorder if there are CRITICAL issues (duplicates)
    if (hasCriticalIssues) {
      console.log('🚨 CRITICAL queue integrity issues found:', criticalIssues);
      console.log('📋 Performing minimal correction for critical issues only...');
      await fixCriticalQueueIssues();
      console.log('✅ Critical queue integrity issues fixed');
      return false;
    }

    if (issues.length > 0) {
      console.log('📋 Minor queue issues (no action needed):', issues);
    } else {
      console.log('✅ Queue integrity validated - no issues found');
    }
    return true;

  } catch (error) {
    console.error('❌ Error validating queue integrity:', error);
    return false;
  }
};

// Function to fix only critical queue issues (duplicates)
const fixCriticalQueueIssues = async () => {
  try {
    console.log('🔧 Fixing critical queue issues (duplicates only)...');

    // Get all online drivers sorted by queue entry time
    const onlineDrivers = await Driver.find({
      isOnline: true,
      isVerified: true
    }).sort({
      queueEntryTime: 1,
      lastActiveTime: 1 // Fallback for drivers without queueEntryTime
    });

    console.log(`📋 Found ${onlineDrivers.length} online drivers to check for duplicates`);

    // Find drivers with duplicate positions
    const positions = onlineDrivers.map(d => d.queuePosition).filter(p => p !== null);
    const duplicates = positions.filter((pos, index) => positions.indexOf(pos) !== index);

    console.log(`📋 Current positions: [${positions.join(', ')}]`);
    console.log(`📋 Duplicate positions detected: [${duplicates.join(', ')}]`);

    if (duplicates.length > 0) {
      console.log(`🚨 FIXING ${duplicates.length} duplicate positions:`, duplicates);

      // Only update drivers that have duplicate positions
      let nextAvailablePosition = Math.max(...positions) + 1;
      console.log(`📋 Starting next available position at: ${nextAvailablePosition}`);

      let fixedCount = 0;

      for (const duplicatePos of [...new Set(duplicates)]) {
        const driversAtPosition = onlineDrivers.filter(d => d.queuePosition === duplicatePos);
        console.log(`📋 Found ${driversAtPosition.length} drivers at position ${duplicatePos}:`);
        driversAtPosition.forEach((d, i) => {
          console.log(`   ${i + 1}. ${d.fullName} (Entry: ${d.queueEntryTime || d.lastActiveTime})`);
        });

        // Keep the first driver (by entry time) at the original position
        // Move others to new positions
        for (let i = 1; i < driversAtPosition.length; i++) {
          const driver = driversAtPosition[i];
          console.log(`📋 MOVING ${driver.fullName}: position ${duplicatePos} → ${nextAvailablePosition}`);

          const updateResult = await Driver.findByIdAndUpdate(driver._id, {
            queuePosition: nextAvailablePosition
          }, { new: true });

          if (updateResult) {
            console.log(`✅ Successfully moved ${driver.fullName} to position ${nextAvailablePosition}`);
            fixedCount++;
          } else {
            console.error(`❌ Failed to update ${driver.fullName}`);
          }

          nextAvailablePosition++;
        }
      }

      console.log(`✅ Critical queue issues fixed: ${fixedCount} drivers repositioned`);
    } else {
      console.log('📋 No duplicate positions found - no fixes needed');
    }

  } catch (error) {
    console.error('❌ Error fixing critical queue issues:', error);
    console.error('❌ Stack trace:', error.stack);
  }
};

// Function to reorder queue by entry time (only used for complete rebuild)
const reorderQueueByEntryTime = async () => {
  try {
    console.log('🔄 FULL REORDER: Rebuilding entire queue by entry time...');
    console.log('⚠️ WARNING: This will change ALL driver positions!');

    // Get all queued drivers (both connected and disconnected) sorted by queue entry time
    const queuedDrivers = await Driver.find({
      inQueue: true,
      isVerified: true
    }).sort({
      queueEntryTime: 1,
      lastActiveTime: 1 // Fallback for drivers without queueEntryTime
    });

    // Log before changes
    console.log('📋 Current queue state before reorder:');
    queuedDrivers.forEach(driver => {
      console.log(`   ${driver.fullName}: Position ${driver.queuePosition} (Entry: ${driver.queueEntryTime || driver.lastActiveTime})`);
    });

    // Reassign positions based on sorted order
    const updatePromises = queuedDrivers.map((driver, index) => {
      const newPosition = index + 1;
      const oldPosition = driver.queuePosition;

      if (oldPosition !== newPosition) {
        console.log(`📋 Driver ${driver.fullName}: ${oldPosition} -> ${newPosition} (Entry: ${driver.queueEntryTime || driver.lastActiveTime})`);
      }

      // Set queue entry time if missing
      const updateData = { queuePosition: newPosition };
      if (!driver.queueEntryTime) {
        updateData.queueEntryTime = driver.lastActiveTime || new Date();
      }

      return Driver.findByIdAndUpdate(driver._id, updateData);
    });

    await Promise.all(updatePromises);
    console.log('✅ Complete queue reordered by entry time');

  } catch (error) {
    console.error('❌ Error reordering queue by entry time:', error);
  }
};

// Helper function to get complete queue state
const getCompleteQueueState = async () => {
  try {
    // Include drivers in queue (both connected and disconnected)
    const queuedDrivers = await Driver.find({
      inQueue: true,
      isVerified: true
    }).sort({
      queueEntryTime: 1,
      lastActiveTime: 1 // Fallback for drivers without queueEntryTime
    });

    return queuedDrivers.map(driver => ({
      driverId: driver._id,
      driverName: driver.fullName,
      queuePosition: driver.queuePosition,
      isOnline: driver.isOnline,
      inQueue: driver.inQueue,
      connectionStatus: driver.connectionStatus || (driver.isOnline ? 'connected' : 'offline'),
      currentPickupLocation: driver.currentPickupLocation,
      lastActiveTime: driver.lastActiveTime,
      queueEntryTime: driver.queueEntryTime
    }));
  } catch (error) {
    console.error('❌ Error getting complete queue state:', error);
    return [];
  }
};

const initializeSocket = (server) => {
  console.log('\n=== INITIALIZING SOCKET.IO SERVER ===');
  
  io = socketIO(server, {
    cors: {
      origin: config.allowedOrigins, // shared with the Express CORS setup (see config/config.js)
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    // Notice a dead connection (phone locked, network switched) within about 18 seconds instead of 45,
    // so a request is never "delivered" to a connection that is already gone
    pingInterval: 10000,
    pingTimeout: 8000
  });

  // Track connection attempts by IP to prevent spam
  const connectionAttempts = new Map();
  const KNOWN_EXPIRED_TIMESTAMP = new Date('2025-07-18T01:35:34.000Z').getTime() / 1000;

  // Authentication middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const clientIP = socket.handshake.address;
    
    console.log('\n=== NEW SOCKET CONNECTION ATTEMPT ===');
    console.log('Token received:', token ? token.substring(0, 20) + '...' : 'undefined');
    console.log('Socket ID:', socket.id);
    console.log('Client IP:', clientIP);
    
    if (!token) {
      console.error('❌ No token provided - rejecting connection');
      return next(new Error('Authentication error: No token provided'));
    }

    try {
      // Check for the specific problematic token before verifying
      const tokenParts = token.split('.');
      if (tokenParts.length === 3) {
        try {
          const payload = JSON.parse(atob(tokenParts[1]));
          if (payload.exp === KNOWN_EXPIRED_TIMESTAMP) {
            console.error('❌ BLOCKED: Known expired token detected');
            console.error('❌ Token expired at:', new Date(payload.exp * 1000).toISOString());
            
            // Track this attempt
            const attemptKey = `${clientIP}-expired`;
            const attempts = connectionAttempts.get(attemptKey) || 0;
            connectionAttempts.set(attemptKey, attempts + 1);
            
            if (attempts > 5) {
              console.error('❌ RATE LIMITED: Too many expired token attempts from IP:', clientIP);
              return next(new Error('Rate limited: Too many expired token attempts'));
            }
            
            // Send aggressive cleanup message
            socket.emit('forceTokenCleanup', {
              error: 'Expired token detected',
              expiredAt: new Date(payload.exp * 1000).toISOString(),
              message: 'Please clear your browser cache and login again',
              action: 'FORCE_RELOAD',
              severity: 'CRITICAL'
            });
            
            // Also emit to all other sockets from this IP (if available)
            const allSockets = io.sockets.sockets;
            allSockets.forEach(s => {
              if (s.id !== socket.id) {
                s.emit('forceTokenCleanup', {
                  error: 'Expired token detected on another session',
                  expiredAt: new Date(payload.exp * 1000).toISOString(),
                  message: 'Please clear your browser cache and login again',
                  action: 'FORCE_RELOAD',
                  severity: 'CRITICAL'
                });
              }
            });
            
            setTimeout(() => {
              socket.disconnect();
            }, 100);
            
            return;
          }
        } catch (parseError) {
          console.error('❌ Error parsing token payload:', parseError);
        }
      }

      // Verify JWT token
      const decoded = jwt.verify(token, config.jwtSecret || process.env.JWT_SECRET);
      console.log('\n✅ JWT Verified successfully');
      console.log('Decoded payload:', {
        id: decoded.id,
        role: decoded.role,
        exp: new Date(decoded.exp * 1000).toISOString(),
        iat: new Date(decoded.iat * 1000).toISOString()
      });

      // Validate required fields
      if (!decoded.id) {
        console.error('❌ Token missing id field');
        return next(new Error('Authentication error: Missing id in token'));
      }
      
      // Determine role from token
      const userRole = decoded.role || 'user';
      console.log('Determined role:', userRole);
      
      // Load full user information based on role
      try {
        if (userRole === 'driver') {
          // Load full driver information
          const driver = await Driver.findById(decoded.id);
          if (!driver) {
            console.error('❌ Driver not found for ID:', decoded.id);
            return next(new Error('Authentication error: Driver not found'));
          }

          socket.user = {
            _id: decoded.id,
            role: userRole,
            fullName: driver.fullName,
            mobileNo: driver.mobileNo,
            vehicleNo: driver.vehicleNo,
            vehicleType: driver.vehicleType,
            currentMetroBooth: driver.currentMetroBooth,
            isOnline: driver.isOnline,
            isVerified: driver.isVerified
          };
          
          console.log('✅ Driver authentication successful:', {
            userId: socket.user._id,
            name: socket.user.fullName,
            vehicle: `${socket.user.vehicleType} - ${socket.user.vehicleNo}`,
            booth: socket.user.currentMetroBooth
          });
        } else if (userRole === 'user') {
          // Load full user information
          const user = await User.findById(decoded.id);
          if (!user) {
            console.error('❌ User not found for ID:', decoded.id);
            return next(new Error('Authentication error: User not found'));
          }

          socket.user = {
            _id: decoded.id,
            role: userRole,
            name: user.name,
            phone: user.phone,
            email: user.email
          };
          
          console.log('✅ User authentication successful:', {
            userId: socket.user._id,
            name: socket.user.name
          });
        } else if (userRole === 'admin') {
          // Load full admin information for admin users
          const admin = await Admin.findById(decoded.id);
          if (!admin) {
            console.error('❌ Admin not found for ID:', decoded.id);
            return next(new Error('Authentication error: Admin not found'));
          }
          if (admin.isActive === false) {
            console.error('❌ Admin account is deactivated:', decoded.id);
            return next(new Error('Authentication error: Account deactivated'));
          }

          socket.user = {
            _id: decoded.id,
            role: userRole
          };

          // Set socket.admin for use in admin-specific handlers
          socket.admin = {
            _id: admin._id,
            fullName: admin.fullName || admin.name || 'Admin',
            email: admin.email,
            role: admin.role,
            permissions: admin.permissions,
            // Executives belong to one pickup point (pod); null for admins
            assignedPickupLocation: admin.assignedPickupLocation || null
          };

          console.log('✅ Admin authentication successful:', {
            adminId: socket.admin._id,
            name: socket.admin.fullName,
            email: socket.admin.email
          });
        } else {
          // For other roles, keep minimal info
          socket.user = {
            _id: decoded.id,
            role: userRole
          };

          console.log('✅ Authentication successful for:', {
            userId: socket.user._id,
            role: socket.user.role
          });
        }
        
        next();
      } catch (err) {
        console.error('❌ Error loading user information:', err);
        return next(new Error('Authentication error: Failed to load user information'));
      }
    } catch (err) {
      console.error('❌ JWT Verification error:', err.message);
      console.error('Error details:', err);
      
      // Handle specific expired token
      if (err.name === 'TokenExpiredError') {
        const isKnownExpired = err.expiredAt && 
          new Date(err.expiredAt).getTime() === new Date('2025-07-18T01:35:34.000Z').getTime();
        
        if (isKnownExpired) {
          console.error('❌ CONFIRMED: This is the known problematic token');
          socket.emit('forceTokenCleanup', {
            error: 'Known expired token',
            expiredAt: err.expiredAt,
            message: 'Please clear your browser cache and login again',
            action: 'FORCE_RELOAD'
          });
        } else {
          // Send specific error for expired tokens
          socket.emit('tokenExpired', {
            error: 'Token expired',
            expiredAt: err.expiredAt,
            message: 'Your session has expired. Please log in again.',
            action: 'REDIRECT_LOGIN'
          });
        }
        
        // Give client time to receive the message before disconnecting
        setTimeout(() => {
          socket.disconnect();
        }, 100);
        
        return;
      }
      
      next(new Error('Authentication error: ' + err.message));
    }
  });

  io.on('connection', async (socket) => {
    console.log('\n=== NEW CLIENT CONNECTED ===');
    console.log('Socket ID:', socket.id);
    console.log('User ID:', socket.user._id);
    console.log('User Role:', socket.user.role);
    console.log('Time:', new Date().toISOString());

    // Track connected client
    connectedClients.set(socket.user._id, socket);
    console.log(`✅ Client ${socket.user._id} added to connected clients map`);

    // Join role-specific room based on the user's role
    if (socket.user.role === 'driver') {
      socket.join('drivers');
      socket.join(`driver_${socket.user._id}`);
      socket.join('admin-room'); // Also join admin room for notifications
      console.log(`\n✅ Driver connected and joined rooms:`);
      console.log(`   Driver ID: ${socket.user._id}`);
      console.log(`   Driver Name: ${socket.user.fullName || socket.user.name}`);
      console.log(`   Vehicle Type: ${socket.user.vehicleType}`);
      console.log(`   Vehicle No: ${socket.user.vehicleNo}`);
      console.log(`   Current Booth: ${socket.user.currentMetroBooth}`);
      console.log(`   Socket ID: ${socket.id}`);
      console.log(`   Rooms joined: drivers, driver_${socket.user._id}, admin-room`);
      
      // Verify driver is actually in the rooms
      const driverSpecificRoom = `driver_${socket.user._id}`;
      setTimeout(() => {
        const rooms = Array.from(socket.rooms);
        const inDriversRoom = rooms.includes('drivers');
        const inDriverSpecificRoom = rooms.includes(driverSpecificRoom);
        const inAdminRoom = rooms.includes('admin-room');
        
        console.log(`🔍 Driver ${socket.user._id} room verification:`, {
          inDriversRoom,
          inDriverSpecificRoom,
          inAdminRoom,
          allRooms: rooms
        });
        
        // Ensure driver is in the room by re-joining if necessary
        if (!inDriverSpecificRoom) {
          console.log(`⚠️ Driver ${socket.user._id} not in specific room, re-joining...`);
          socket.join(driverSpecificRoom);
        }
        if (!inDriversRoom) {
          console.log(`⚠️ Driver ${socket.user._id} not in drivers room, re-joining...`);
          socket.join('drivers');
        }
        if (!inAdminRoom) {
          console.log(`⚠️ Driver ${socket.user._id} not in admin room, re-joining...`);
          socket.join('admin-room');
        }
      }, 1000);
      
      // Log all driver connections
      const driversRoom = io.sockets.adapter.rooms.get('drivers');
      console.log(`Total drivers online: ${driversRoom ? driversRoom.size : 0}`);

      // Hand over any request that was assigned while this driver was disconnected. It is sent at once and
      // once more after 2.5 s in case the driver app had not attached its listeners yet (a page that is still
      // loading); requests the app already confirmed are not sent again.
      setTimeout(() => deliverPendingRequests(socket, 'connect', { onlyUnconfirmed: true }), 300);
      setTimeout(() => deliverPendingRequests(socket, 'connect (retry)', { onlyUnconfirmed: true }), 2500);
    } else if (socket.user.role === 'admin' && isExecutive(socket.admin)) {
      // An executive (sub-admin of one pickup point) never joins the rooms that carry every pod's bookings:
      // only their own room, the room that holds all executives (drivers and the queue are shared) and the
      // room of their pod (its bookings and rides)
      socket.join(`admin_${socket.user._id}`);
      socket.join(EXECUTIVES_ROOM);
      const executivePodRoom = podRoomName(podOf(socket.admin));
      if (executivePodRoom) socket.join(executivePodRoom);
      console.log(`✅ Executive ${socket.user._id} joined rooms: admin_${socket.user._id}, ${EXECUTIVES_ROOM}, ${executivePodRoom || '(no pod)'}`);
    } else if (socket.user.role === 'admin') {
      socket.join('admins');
      socket.join('admin-room');
      socket.join(`admin_${socket.user._id}`);
      console.log(`✅ Admin ${socket.user._id} joined rooms: admins, admin-room, admin_${socket.user._id}`);
      
      // Send queued notifications to reconnecting admin
      if (enhancedNotificationService) {
        enhancedNotificationService.sendQueuedNotifications(socket.id);
      }
      
      // Log all admin connections
      const adminsRoom = io.sockets.adapter.rooms.get('admins');
      console.log(`Total admins online: ${adminsRoom ? adminsRoom.size : 0}`);
    } else {
      socket.join(`user_${socket.user._id}`);
      console.log(`✅ User ${socket.user._id} joined room: user_${socket.user._id}`);
    }

    // Send connection success confirmation
    socket.emit('connectionSuccess', {
      status: 'connected',
      userId: socket.user._id,
      role: socket.user.role,
      socketId: socket.id,
      timestamp: new Date().toISOString()
    });

    // Handle driver room rejoin (for connection recovery)
    socket.on('driverRoomRejoin', async (data) => {
      console.log('\n=== DRIVER ROOM REJOIN ===');
      console.log('Driver ID:', socket.user._id);
      console.log('Driver Name:', data.driverName);
      console.log('Timestamp:', data.timestamp);
      
      try {
        // Ensure driver is in all required rooms
        const driverSpecificRoom = `driver_${socket.user._id}`;
        const requiredRooms = ['drivers', driverSpecificRoom, 'admin-room'];
        
        console.log(`[DriverRoomRejoin] Rejoining rooms for driver ${socket.user._id}:`, requiredRooms);
        
        // Join all required rooms
        requiredRooms.forEach(roomName => {
          socket.join(roomName);
          console.log(`✅ Driver ${socket.user._id} rejoined room: ${roomName}`);
        });
        
        // Update driver online status in database when rejoining
        // This ensures the driver is marked as online for manual bookings
        const driver = await Driver.findById(socket.user._id);
        if (driver) {
          const wasDisconnected = !driver.isOnline && driver.inQueue;

          if (!driver.isOnline) {
            // Check if driver has inQueue flag - if false, driver was intentionally set offline
            // by admin or by their own action, don't auto-restore
            if (!driver.inQueue) {
              console.log(`⛔ Driver ${socket.user._id} (${driver.fullName}) is offline and NOT in queue - REJECTING auto-restore`);
              console.log(`   This prevents auto-rejoin after admin sets driver offline`);
              socket.emit('roomRejoinConfirmed', {
                success: true,
                restored: false,
                isOnline: false,
                inQueue: false,
                message: 'You are offline. Please go online manually to join the queue.'
              });
              return;
            }

            console.log(`📝 Driver ${socket.user._id} reconnecting with queue preserved...`);

            // Only restore if driver was in queue (disconnected, not offline)
            const newConnectionStatus = 'connected';

            await Driver.findByIdAndUpdate(socket.user._id, {
              isOnline: true,
              connectionStatus: newConnectionStatus,
              lastActiveTime: new Date()
              // NOTE: Keep inQueue and queuePosition unchanged!
            });

            console.log(`✅ Driver ${driver.fullName} reconnected:`);
            console.log(`   - In queue: ${driver.inQueue}`);
            console.log(`   - Queue position: ${driver.queuePosition}`);
            console.log(`   - Connection status: ${newConnectionStatus}`);

            // If driver was in queue but disconnected, broadcast reconnection
            if (wasDisconnected) {
              console.log(`🔔 Driver ${driver.fullName} was in queue - broadcasting reconnection`);

              // Notify admins that driver is now reachable again
              notifyAdmins('driverReconnected', {
                driverId: socket.user._id,
                driverName: driver.fullName,
                queuePosition: driver.queuePosition,
                metroBooth: driver.currentMetroBooth,
                vehicleType: driver.vehicleType,
                timestamp: new Date().toISOString(),
                message: 'Driver reconnected and is now reachable'
              });

              // Broadcast status change
              broadcastStateChange('driverStatusChanged', {
                driverId: socket.user._id,
                driverName: driver.fullName,
                isOnline: true,
                inQueue: true,
                queuePosition: driver.queuePosition,
                connectionStatus: 'connected',
                currentPickupLocation: driver.currentMetroBooth,
                lastActiveTime: new Date().toISOString(),
                changedBy: 'system',
                reason: 'reconnect',
                timestamp: new Date().toISOString()
              });
            }
          } else {
            console.log(`✅ Driver ${socket.user._id} already online in database`);
          }

          // Hand the driver every request assigned to them that they have not seen (or that is still counting
          // down): both direct manual bookings ("pending") and Fleet Manager assignments ("pending_fm").
          // The driver app asked for this explicitly, so requests are sent even if already confirmed on this
          // connection; the app ignores duplicates.
          const sentCount = await deliverPendingRequests(socket, 'rejoin');
          console.log(`[driverRoomRejoin] ${sentCount} pending request(s) sent to driver ${driver.fullName}`);
        }

        // Verify room membership after joining
        setTimeout(() => {
          const rooms = Array.from(socket.rooms);
          console.log(`🔍 Driver ${socket.user._id} current rooms after rejoin:`, rooms);
          
          // Send confirmation back to driver
          socket.emit('roomRejoinConfirmed', {
            success: true,
            rooms: rooms,
            timestamp: new Date().toISOString(),
            message: 'Successfully rejoined all required rooms'
          });
        }, 500);
        
      } catch (error) {
        console.error('❌ Error during driver room rejoin:', error);
        socket.emit('roomRejoinConfirmed', {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    });

    // Handle driver going online with metro booth selection
    // NEW: Now requires admin approval workflow
    socket.on('driverGoOnline', async (data) => {
      console.log('\n=== DRIVER GOING ONLINE (Approval Workflow) ===');
      console.log('Driver ID:', socket.user._id);
      console.log('Metro booth data:', data);

      try {
        const { metroBooth, location, vehicleType } = data;
        const DriverOnlineRequest = require('./models/DriverOnlineRequest');

        // Get current driver state
        const currentDriver = await Driver.findById(socket.user._id);
        if (!currentDriver) {
          socket.emit('driverOnlineConfirmed', {
            success: false,
            error: 'Driver not found'
          });
          return;
        }

        // If driver is already online and in queue, return success
        if (currentDriver.isOnline && currentDriver.inQueue) {
          console.log('✅ Driver is already online');
          socket.emit('driverOnlineConfirmed', {
            success: true,
            alreadyOnline: true,
            metroBooth: currentDriver.currentMetroBooth,
            vehicleType: currentDriver.vehicleType,
            message: 'You are already online',
            roomStatus: {
              inDriversRoom: Array.from(socket.rooms).includes('drivers'),
              inDriverSpecificRoom: Array.from(socket.rooms).includes(`driver_${socket.user._id}`),
              allRooms: Array.from(socket.rooms)
            }
          });
          return;
        }

        // Use fixed pickup location if not provided
        const fixedMetroBooth = metroBooth || "Hauz Khas Metro Gate No 1";
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        // ATOMIC: Use findOneAndUpdate with upsert to prevent race conditions
        // This prevents multiple requests from being created when driver clicks rapidly
        const existingOrNew = await DriverOnlineRequest.findOneAndUpdate(
          {
            driverId: socket.user._id,
            status: 'pending'
          },
          {
            $setOnInsert: {
              driverId: currentDriver._id,
              driverName: currentDriver.fullName,
              driverPhone: currentDriver.mobileNo,
              driverPhoto: currentDriver.driverSelfie,
              boothName: fixedMetroBooth,
              vehicleType: vehicleType || currentDriver.vehicleType,
              location: location ? {
                type: 'Point',
                coordinates: [location.lng || 0, location.lat || 0]
              } : undefined,
              expiresAt,
              requestedAt: new Date(),
              status: 'pending'
            }
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true
          }
        );

        // Check if this was an existing request (created before this call)
        // By checking if requestedAt is more than 2 seconds old
        const isExistingRequest = existingOrNew.requestedAt &&
          (Date.now() - new Date(existingOrNew.requestedAt).getTime() > 2000);

        if (isExistingRequest) {
          console.log('⏳ Driver already has a pending request (atomic check)');
          socket.emit('driverOnlineConfirmed', {
            success: true,
            pendingApproval: true,
            requestId: existingOrNew._id,
            boothName: existingOrNew.boothName,
            expiresAt: existingOrNew.expiresAt,
            message: 'Waiting for admin approval'
          });
          return;
        }

        // This is a newly created request
        const newRequest = existingOrNew;

        // Update driver with pending request reference (skip validation to avoid issues with incomplete driver data)
        await Driver.findByIdAndUpdate(currentDriver._id, {
          pendingOnlineRequest: newRequest._id
        });

        console.log(`📋 Online request created for driver ${socket.user._id}`);
        console.log(`   Request ID: ${newRequest._id}`);
        console.log(`   Expires at: ${expiresAt.toISOString()}`);

        logRideEvent(`DRIVER-${socket.user._id}`, 'driver_online_request', {
          requestId: newRequest._id,
          metroBooth: fixedMetroBooth,
          vehicleType,
          location,
          expiresAt
        });

        // Notify admins of new online request
        notifyAdmins('newOnlineRequest', {
          request: {
            _id: newRequest._id,
            driverId: newRequest.driverId,
            driverName: newRequest.driverName,
            driverPhone: newRequest.driverPhone,
            driverPhoto: newRequest.driverPhoto,
            boothName: newRequest.boothName,
            vehicleType: newRequest.vehicleType,
            requestedAt: newRequest.requestedAt,
            expiresAt: newRequest.expiresAt
          },
          message: `${currentDriver.fullName} wants to go online at ${fixedMetroBooth}`
        });

        socket.emit('driverOnlineConfirmed', {
          success: true,
          pendingApproval: true,
          requestId: newRequest._id,
          boothName: fixedMetroBooth,
          vehicleType: vehicleType || currentDriver.vehicleType,
          expiresAt: expiresAt,
          message: 'Your online request has been submitted. Waiting for admin approval.',
          roomStatus: {
            inDriversRoom: Array.from(socket.rooms).includes('drivers'),
            inDriverSpecificRoom: Array.from(socket.rooms).includes(`driver_${socket.user._id}`),
            allRooms: Array.from(socket.rooms)
          }
        });

      } catch (error) {
        console.error('❌ Error creating online request:', error);
        socket.emit('driverOnlineConfirmed', { success: false, error: error.message });
      }
    });

    // Handle admin approving driver online request (socket-based for real-time)
    socket.on('approveOnlineRequest', async (data) => {
      console.log('\n=== ADMIN: APPROVE ONLINE REQUEST (Socket) ===');
      console.log('Admin:', socket.admin?.fullName);
      console.log('Request ID:', data?.requestId);

      try {
        if (!socket.admin) {
          socket.emit('approveOnlineRequestResult', {
            success: false,
            error: 'Admin authentication required'
          });
          return;
        }

        const { requestId } = data;
        const DriverOnlineRequest = require('./models/DriverOnlineRequest');

        const request = await DriverOnlineRequest.findById(requestId);
        if (!request) {
          socket.emit('approveOnlineRequestResult', {
            success: false,
            error: 'Request not found'
          });
          return;
        }

        if (request.status !== 'pending') {
          socket.emit('approveOnlineRequestResult', {
            success: false,
            error: `Request is already ${request.status}`
          });
          return;
        }

        // Approve the request
        await request.approve(socket.admin._id, socket.admin.fullName);

        // Update driver status - add to queue (use findByIdAndUpdate to skip validation)
        const queueEntryTime = new Date();

        // Check if driver's socket is actually connected
        const driverSocketConnected = connectedClients.has(request.driverId.toString());
        console.log(`📡 Driver ${request.driverId} socket connected: ${driverSocketConnected}`);

        const updateData = {
          isOnline: true,
          inQueue: true,
          connectionStatus: driverSocketConnected ? 'connected' : 'disconnected',
          currentMetroBooth: request.boothName,
          queueEntryTime: queueEntryTime,
          lastActiveTime: queueEntryTime,
          pendingOnlineRequest: null,
          lastAdminQueueAction: new Date() // Prevent client sync from overriding this admin action
        };

        if (request.location && request.location.coordinates) {
          updateData.location = {
            type: 'Point',
            coordinates: request.location.coordinates,
            lastUpdated: new Date()
          };
        }

        const driver = await Driver.findByIdAndUpdate(
          request.driverId,
          updateData,
          { new: true }
        );

        if (driver) {

          // Update queue positions
          await updateQueueAfterDriverAddition(driver._id);

          // Refetch driver to get the updated queue position
          const updatedDriver = await Driver.findById(driver._id).select('queuePosition');
          const assignedQueuePosition = updatedDriver?.queuePosition || 1;

          // Update metro station online drivers count
          const metroStation = await MetroStation.findOne({ name: request.boothName });
          if (metroStation) {
            await metroStation.incrementOnlineDrivers();
          }

          console.log(`✅ Driver ${driver.fullName} approved and added to queue at ${request.boothName} (position: ${assignedQueuePosition})`);

          // Notify the driver with queue position and connection status
          io.to(`driver_${request.driverId}`).emit('onlineRequestApproved', {
            requestId: request._id,
            approvedBy: socket.admin.fullName,
            boothName: request.boothName,
            queuePosition: assignedQueuePosition,
            connectionStatus: driver.connectionStatus,
            isOnline: true,
            inQueue: true,
            message: 'Your online request has been approved! You are now online.'
          });

          // Broadcast driver status change
          broadcastStateChange('driverStatusChanged', {
            driverId: driver._id,
            driverName: driver.fullName,
            isOnline: true,
            inQueue: true,
            connectionStatus: driver.connectionStatus,
            currentPickupLocation: request.boothName,
            vehicleType: driver.vehicleType,
            lastActiveTime: queueEntryTime.toISOString(),
            changedBy: 'admin',
            adminName: socket.admin.fullName,
            timestamp: new Date().toISOString()
          });
        }

        // Notify other admins
        toAdminsAndExecutives(io, 'admins').emit('onlineRequestProcessed', {
          requestId: request._id,
          driverName: request.driverName,
          status: 'approved',
          processedBy: socket.admin.fullName
        });

        socket.emit('approveOnlineRequestResult', {
          success: true,
          message: `${request.driverName} has been approved`,
          request: {
            _id: request._id,
            driverName: request.driverName,
            boothName: request.boothName,
            status: 'approved'
          }
        });

      } catch (error) {
        console.error('❌ Error approving online request:', error);
        socket.emit('approveOnlineRequestResult', { success: false, error: error.message });
      }
    });

    // Handle admin rejecting driver online request (socket-based for real-time)
    socket.on('rejectOnlineRequest', async (data) => {
      console.log('\n=== ADMIN: REJECT ONLINE REQUEST (Socket) ===');
      console.log('Admin:', socket.admin?.fullName);
      console.log('Request ID:', data?.requestId);

      try {
        if (!socket.admin) {
          socket.emit('rejectOnlineRequestResult', {
            success: false,
            error: 'Admin authentication required'
          });
          return;
        }

        const { requestId, reason = '' } = data;
        const DriverOnlineRequest = require('./models/DriverOnlineRequest');

        const request = await DriverOnlineRequest.findById(requestId);
        if (!request) {
          socket.emit('rejectOnlineRequestResult', {
            success: false,
            error: 'Request not found'
          });
          return;
        }

        if (request.status !== 'pending') {
          socket.emit('rejectOnlineRequestResult', {
            success: false,
            error: `Request is already ${request.status}`
          });
          return;
        }

        // Reject the request
        await request.reject(socket.admin._id, socket.admin.fullName, reason);

        // Update driver's pending request reference AND ensure isOnline is false
        // This prevents state sync from restoring isOnline: true after rejection
        await Driver.findByIdAndUpdate(request.driverId, {
          pendingOnlineRequest: null,
          isOnline: false,
          inQueue: false,
          queuePosition: null,
          lastAdminQueueAction: new Date() // Prevent client sync from overriding this admin action
        });

        console.log(`✅ Online request rejected for driver ${request.driverName} - driver set to offline`);

        // CRITICAL: Broadcast queue update to all clients (admin dashboard)
        // Without this, admin keeps seeing the driver in queue!
        await updateQueueAfterDriverRemoval(request.driverId);

        // Broadcast status change to all clients
        broadcastStateChange('driverStatusChanged', {
          driverId: request.driverId,
          driverName: request.driverName,
          isOnline: false,
          inQueue: false,
          queuePosition: null,
          connectionStatus: 'offline',
          changedBy: 'admin',
          reason: 'online_request_rejected',
          timestamp: new Date().toISOString()
        });

        // Notify the driver
        io.to(`driver_${request.driverId}`).emit('onlineRequestRejected', {
          requestId: request._id,
          rejectedBy: socket.admin.fullName,
          reason: reason || 'No reason provided',
          message: 'Your online request has been rejected. You can submit a new request.'
        });

        // Notify other admins
        toAdminsAndExecutives(io, 'admins').emit('onlineRequestProcessed', {
          requestId: request._id,
          driverName: request.driverName,
          status: 'rejected',
          processedBy: socket.admin.fullName
        });

        socket.emit('rejectOnlineRequestResult', {
          success: true,
          message: `${request.driverName}'s request has been rejected`,
          request: {
            _id: request._id,
            driverName: request.driverName,
            status: 'rejected'
          }
        });

      } catch (error) {
        console.error('❌ Error rejecting online request:', error);
        socket.emit('rejectOnlineRequestResult', { success: false, error: error.message });
      }
    });

    // Handle driver requesting to go offline (requires admin approval)
    // Part of Admin-Only Queue Management System
    socket.on('driverGoOffline', async (data) => {
      console.log('\n=== DRIVER OFFLINE REQUEST ===');
      console.log('Driver ID:', socket.user._id);

      try {
        const DriverOfflineRequest = require('./models/DriverOfflineRequest');
        const driver = await Driver.findById(socket.user._id);

        if (!driver) {
          socket.emit('driverOfflineConfirmed', { success: false, error: 'Driver not found' });
          return;
        }

        // If driver is already offline, just confirm
        if (!driver.isOnline && !driver.inQueue) {
          socket.emit('driverOfflineConfirmed', {
            success: true,
            message: 'You are already offline'
          });
          return;
        }

        // If driver has an active ride, block offline request
        if (driver.currentRide) {
          socket.emit('driverOfflineConfirmed', {
            success: false,
            error: 'Cannot request offline while on active ride. Complete the ride first.'
          });
          return;
        }

        // Check for existing pending offline request
        const existingRequest = await DriverOfflineRequest.findOne({
          driverId: socket.user._id,
          status: 'pending'
        });

        if (existingRequest) {
          socket.emit('driverOfflineConfirmed', {
            success: true,
            pendingApproval: true,
            requestId: existingRequest._id,
            expiresAt: existingRequest.expiresAt,
            message: 'Your offline request is already pending admin approval'
          });
          return;
        }

        // Create offline request (don't set offline yet - wait for admin approval)
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiry

        const newRequest = await DriverOfflineRequest.create({
          driverId: driver._id,
          driverName: driver.fullName,
          driverPhone: driver.mobileNo,
          boothName: driver.currentMetroBooth,
          queuePosition: driver.queuePosition,
          reason: data?.reason || 'Driver requested to go offline',
          expiresAt
        });

        // Update driver with pending request reference
        await Driver.findByIdAndUpdate(driver._id, {
          pendingOfflineRequest: newRequest._id
        });

        console.log(`📋 Offline request created for driver ${driver.fullName} (ID: ${newRequest._id})`);
        logRideEvent(`DRIVER-${socket.user._id}`, 'offline_request_created', {
          requestId: newRequest._id,
          queuePosition: driver.queuePosition
        });

        // Notify admins of new offline request
        notifyAdmins('newOfflineRequest', {
          request: {
            _id: newRequest._id,
            driverId: driver._id,
            driverName: driver.fullName,
            driverPhone: driver.mobileNo,
            boothName: driver.currentMetroBooth,
            queuePosition: driver.queuePosition,
            reason: newRequest.reason,
            requestedAt: newRequest.requestedAt,
            expiresAt: newRequest.expiresAt
          },
          message: `${driver.fullName} wants to go offline (Queue #${driver.queuePosition})`
        });

        // Tell driver to wait for approval
        socket.emit('driverOfflineConfirmed', {
          success: true,
          pendingApproval: true,
          requestId: newRequest._id,
          expiresAt: newRequest.expiresAt,
          message: 'Your offline request has been sent to admin for approval.'
        });

      } catch (error) {
        console.error('❌ Error creating offline request:', error);
        socket.emit('driverOfflineConfirmed', { success: false, error: error.message });
      }
    });

    // Admin approves offline request
    // Part of Admin-Only Queue Management System
    socket.on('approveOfflineRequest', async (data) => {
      console.log('\n=== ADMIN: APPROVE OFFLINE REQUEST ===');

      try {
        if (!socket.admin) {
          socket.emit('approveOfflineRequestResult', { success: false, error: 'Admin authentication required' });
          return;
        }

        const { requestId } = data;
        const DriverOfflineRequest = require('./models/DriverOfflineRequest');
        const request = await DriverOfflineRequest.findById(requestId);

        if (!request) {
          socket.emit('approveOfflineRequestResult', { success: false, error: 'Request not found' });
          return;
        }

        if (request.status !== 'pending') {
          socket.emit('approveOfflineRequestResult', { success: false, error: 'Request already processed' });
          return;
        }

        // Approve the request
        request.status = 'approved';
        request.processedBy = socket.admin._id;
        request.processedByName = socket.admin.fullName;
        request.processedAt = new Date();
        await request.save();

        // NOW set driver offline
        const metroBooth = request.boothName;
        await Driver.findByIdAndUpdate(request.driverId, {
          isOnline: false,
          inQueue: false,
          queuePosition: null,
          queueEntryTime: null,
          connectionStatus: 'offline',
          currentMetroBooth: null,
          pendingOfflineRequest: null
        });

        // Update metro station online drivers count
        if (metroBooth) {
          const metroStation = await MetroStation.findOne({ name: metroBooth });
          if (metroStation) {
            await metroStation.decrementOnlineDrivers();
          }
        }

        // Update queue positions
        await updateQueueAfterDriverRemoval(request.driverId);

        console.log(`✅ Offline request approved for ${request.driverName} by ${socket.admin.fullName}`);
        logRideEvent(`DRIVER-${request.driverId}`, 'offline_request_approved', {
          requestId: request._id,
          approvedBy: socket.admin.fullName
        });

        // Notify driver
        io.to(`driver_${request.driverId}`).emit('offlineRequestApproved', {
          message: 'Your offline request has been approved. You are now offline.'
        });

        // Broadcast status change
        broadcastStateChange('driverStatusChanged', {
          driverId: request.driverId,
          driverName: request.driverName,
          isOnline: false,
          inQueue: false,
          queuePosition: null,
          connectionStatus: 'offline',
          changedBy: 'admin',
          reason: 'offline_request_approved',
          timestamp: new Date().toISOString()
        });

        // Notify other admins
        toAdminsAndExecutives(io, 'admins').emit('offlineRequestProcessed', {
          requestId: request._id,
          driverName: request.driverName,
          status: 'approved',
          processedBy: socket.admin.fullName
        });

        socket.emit('approveOfflineRequestResult', {
          success: true,
          message: `${request.driverName} is now offline`,
          request: {
            _id: request._id,
            driverName: request.driverName,
            status: 'approved'
          }
        });

      } catch (error) {
        console.error('❌ Error approving offline request:', error);
        socket.emit('approveOfflineRequestResult', { success: false, error: error.message });
      }
    });

    // Admin rejects offline request
    // Part of Admin-Only Queue Management System
    socket.on('rejectOfflineRequest', async (data) => {
      console.log('\n=== ADMIN: REJECT OFFLINE REQUEST ===');

      try {
        if (!socket.admin) {
          socket.emit('rejectOfflineRequestResult', { success: false, error: 'Admin authentication required' });
          return;
        }

        const { requestId, reason } = data;
        const DriverOfflineRequest = require('./models/DriverOfflineRequest');
        const request = await DriverOfflineRequest.findById(requestId);

        if (!request) {
          socket.emit('rejectOfflineRequestResult', { success: false, error: 'Request not found' });
          return;
        }

        if (request.status !== 'pending') {
          socket.emit('rejectOfflineRequestResult', { success: false, error: 'Request already processed' });
          return;
        }

        // Reject the request
        request.status = 'rejected';
        request.processedBy = socket.admin._id;
        request.processedByName = socket.admin.fullName;
        request.processedAt = new Date();
        request.rejectionReason = reason || 'Admin rejected the request';
        await request.save();

        // Clear pending request from driver
        await Driver.findByIdAndUpdate(request.driverId, {
          pendingOfflineRequest: null
        });

        console.log(`❌ Offline request rejected for ${request.driverName} by ${socket.admin.fullName}`);
        logRideEvent(`DRIVER-${request.driverId}`, 'offline_request_rejected', {
          requestId: request._id,
          rejectedBy: socket.admin.fullName,
          reason: reason
        });

        // Notify driver
        io.to(`driver_${request.driverId}`).emit('offlineRequestRejected', {
          message: reason || 'Your offline request was rejected. Please stay online.'
        });

        // Notify other admins
        toAdminsAndExecutives(io, 'admins').emit('offlineRequestProcessed', {
          requestId: request._id,
          driverName: request.driverName,
          status: 'rejected',
          processedBy: socket.admin.fullName
        });

        socket.emit('rejectOfflineRequestResult', {
          success: true,
          message: `${request.driverName}'s offline request has been rejected`,
          request: {
            _id: request._id,
            driverName: request.driverName,
            status: 'rejected'
          }
        });

      } catch (error) {
        console.error('❌ Error rejecting offline request:', error);
        socket.emit('rejectOfflineRequestResult', { success: false, error: error.message });
      }
    });

    // Admin directly removes driver from queue (no request needed)
    // Part of Admin-Only Queue Management System
    socket.on('adminRemoveFromQueue', async (data) => {
      console.log('\n=== ADMIN: REMOVE DRIVER FROM QUEUE ===');

      try {
        if (!socket.admin) {
          socket.emit('adminRemoveFromQueueResult', { success: false, error: 'Admin authentication required' });
          return;
        }

        const { driverId, reason } = data;
        const driver = await Driver.findById(driverId);

        if (!driver) {
          socket.emit('adminRemoveFromQueueResult', { success: false, error: 'Driver not found' });
          return;
        }

        // Check if driver has active ride
        if (driver.currentRide) {
          socket.emit('adminRemoveFromQueueResult', {
            success: false,
            error: 'Cannot remove driver with active ride. Wait for ride to complete.'
          });
          return;
        }

        const metroBooth = driver.currentMetroBooth;
        const previousPosition = driver.queuePosition;

        // Cancel any pending offline request
        const DriverOfflineRequest = require('./models/DriverOfflineRequest');
        await DriverOfflineRequest.updateMany(
          { driverId: driver._id, status: 'pending' },
          { status: 'cancelled', processedAt: new Date() }
        );

        // Set driver offline
        await Driver.findByIdAndUpdate(driverId, {
          isOnline: false,
          inQueue: false,
          queuePosition: null,
          queueEntryTime: null,
          connectionStatus: 'offline',
          currentMetroBooth: null,
          pendingOfflineRequest: null,
          lastAdminQueueAction: new Date() // Prevent client sync from overriding this admin action
        });

        // Update metro station count
        if (metroBooth) {
          const metroStation = await MetroStation.findOne({ name: metroBooth });
          if (metroStation) {
            await metroStation.decrementOnlineDrivers();
          }
        }

        // Update queue positions
        await updateQueueAfterDriverRemoval(driverId);

        console.log(`✅ Admin ${socket.admin.fullName} removed ${driver.fullName} from queue`);
        logRideEvent(`DRIVER-${driverId}`, 'admin_removed_from_queue', {
          removedBy: socket.admin.fullName,
          previousPosition,
          reason
        });

        // Notify driver
        io.to(`driver_${driverId}`).emit('removedFromQueue', {
          reason: 'admin_action',
          message: reason || 'You have been removed from the queue by admin.',
          timestamp: new Date().toISOString()
        });

        // Broadcast status change
        broadcastStateChange('driverStatusChanged', {
          driverId: driverId,
          driverName: driver.fullName,
          isOnline: false,
          inQueue: false,
          queuePosition: null,
          connectionStatus: 'offline',
          changedBy: 'admin',
          reason: 'admin_removed_from_queue',
          timestamp: new Date().toISOString()
        });

        socket.emit('adminRemoveFromQueueResult', {
          success: true,
          message: `${driver.fullName} has been removed from the queue`,
          driverId: driverId,
          driverName: driver.fullName
        });

      } catch (error) {
        console.error('❌ Error removing driver from queue:', error);
        socket.emit('adminRemoveFromQueueResult', { success: false, error: error.message });
      }
    });

    // Handle admin queue validation request
    socket.on('validateQueue', async () => {
      console.log('\n=== ADMIN QUEUE VALIDATION REQUEST ===');
      console.log('Admin ID:', socket.user._id);
      console.log('Admin Role:', socket.user.role);
      
      try {
        // Verify admin role
        if (socket.user.role !== 'admin') {
          console.error('❌ Unauthorized: Only admins can validate queue');
          socket.emit('queueValidationError', { 
            success: false, 
            error: 'Unauthorized: Only admins can validate queue' 
          });
          return;
        }
        
        // Run queue validation
        const isValid = await validateQueueIntegrity();
        
        // Get current queue state
        const queueState = await getCompleteQueueState();
        
        // Send validation result
        socket.emit('queueValidationResult', {
          success: true,
          isValid,
          queueState,
          timestamp: new Date().toISOString(),
          message: isValid ? 'Queue is valid' : 'Queue issues found and fixed'
        });
        
        // If queue was fixed, notify all admins
        if (!isValid) {
          notifyAdmins('queuePositionsUpdated', {
            queueUpdates: queueState,
            totalOnline: queueState.length,
            timestamp: new Date().toISOString(),
            action: 'queue_validation_fix'
          });
        }
        
        console.log(`✅ Queue validation completed by admin ${socket.user._id}`);
        
      } catch (error) {
        console.error('❌ Error during queue validation:', error);
        socket.emit('queueValidationError', { 
          success: false, 
          error: error.message 
        });
      }
    });

    // Handle admin driver status toggle
    socket.on('adminToggleDriverStatus', async (data) => {
      console.log('\n=== ADMIN TOGGLING DRIVER STATUS ===');
      console.log('Admin ID:', socket.user._id);
      console.log('Admin Role:', socket.user.role);
      console.log('Target Driver ID:', data.driverId);
      console.log('New Status:', data.isOnline);
      
      try {
        // Verify admin role
        if (socket.user.role !== 'admin') {
          console.error('❌ Unauthorized: Only admins can toggle driver status');
          socket.emit('adminToggleDriverStatusError', { 
            success: false, 
            error: 'Unauthorized: Only admins can toggle driver status' 
          });
          return;
        }
        
        const driver = await Driver.findById(data.driverId);
        if (!driver) {
          console.error('❌ Driver not found');
          socket.emit('adminToggleDriverStatusError', { 
            success: false, 
            error: 'Driver not found' 
          });
          return;
        }
        
        // Check for potential conflicts - if driver recently changed status
        const recentChangeThreshold = new Date(Date.now() - 3000); // 3 seconds
        if (driver.lastActiveTime && driver.lastActiveTime > recentChangeThreshold && driver.isOnline === data.isOnline) {
          console.log('⚠️ Driver recently changed to same status, possible conflict');
          socket.emit('adminToggleDriverStatusError', { 
            success: false, 
            conflict: true,
            currentState: {
              isOnline: driver.isOnline,
              currentMetroBooth: driver.currentMetroBooth,
              queuePosition: driver.queuePosition
            },
            error: 'Driver recently changed to this status. Current state may be up to date.'
          });
          return;
        }
        
        // Update driver status
        const queueEntryTime = new Date();
        const updateData = {
          isOnline: data.isOnline,
          lastActiveTime: queueEntryTime,
          lastAdminQueueAction: new Date() // Prevent client sync from overriding this admin action
        };

        // If setting online, set queue entry time
        if (data.isOnline) {
          updateData.queueEntryTime = queueEntryTime;
          console.log(`📋 Admin setting driver ${data.driverId} online with queue entry time: ${queueEntryTime.toISOString()}`);
        } else {
          // If setting offline, clear ALL queue-related fields to prevent auto-rejoin
          updateData.currentMetroBooth = null;
          updateData.currentPickupLocation = null;
          updateData.queueEntryTime = null;
          updateData.inQueue = false;  // Prevent auto-rejoin on reconnect
          updateData.queuePosition = null;  // Remove from queue position
          updateData.connectionStatus = 'offline';  // Set explicit offline status
          console.log(`📋 Admin setting driver ${data.driverId} offline - clearing ALL queue data to prevent auto-rejoin`);
        }
        
        await Driver.findByIdAndUpdate(data.driverId, updateData);
        
        // Update metro station online drivers count
        if (driver.currentMetroBooth) {
          const metroStation = await MetroStation.findOne({ name: driver.currentMetroBooth });
          if (metroStation) {
            if (data.isOnline) {
              await metroStation.incrementOnlineDrivers();
            } else {
              await metroStation.decrementOnlineDrivers();
            }
          }
        }
        
        console.log(`✅ Admin ${socket.user._id} toggled driver ${data.driverId} status to ${data.isOnline ? 'online' : 'offline'}`);
        logRideEvent(`ADMIN-${socket.user._id}`, 'admin_toggle_driver_status', { 
          driverId: data.driverId, 
          newStatus: data.isOnline 
        });
        
        // Find driver socket and notify them
        const driverSocket = connectedClients.get(data.driverId);
        if (driverSocket) {
          driverSocket.emit('statusChangedByAdmin', {
            isOnline: data.isOnline,
            message: `Your status has been changed to ${data.isOnline ? 'online' : 'offline'} by admin`,
            changedBy: 'admin',
            timestamp: new Date().toISOString()
          });
        }
        
        // Update queue positions after admin status change
        console.log('🔄 Updating queue after admin status change...');
        if (data.isOnline) {
          await updateQueueAfterDriverAddition(data.driverId);
        } else {
          await updateQueueAfterDriverRemoval(data.driverId);
        }
        
        // Broadcast comprehensive status update
        broadcastStateChange('driverStatusUpdated', {
          driverId: data.driverId,
          driverName: driver.fullName,
          isOnline: data.isOnline,
          currentPickupLocation: driver.currentPickupLocation,
          lastActiveTime: updateData.lastActiveTime,
          changedBy: 'admin',
          adminId: socket.user._id,
          timestamp: new Date().toISOString()
        });
        
        // Confirm to the admin who made the change
        socket.emit('adminToggleDriverStatusConfirmed', { 
          success: true,
          message: `Driver ${data.isOnline ? 'set online' : 'set offline'} successfully`
        });
        
      } catch (error) {
        console.error('❌ Error toggling driver status:', error);
        socket.emit('adminToggleDriverStatusError', { 
          success: false, 
          error: error.message 
        });
      }
    });

    // DISABLED: Handle ride request broadcasting from API (customer online booking removed)
    socket.on('broadcastRideRequest', async (data) => {
      console.log('\n=== RIDE BROADCAST BLOCKED - CUSTOMER BOOKING DISABLED ===');
      console.log('Attempt blocked for ride ID:', data.rideId);
      
      socket.emit('error', { 
        message: 'Customer online booking is disabled. All rides must be created through admin manual booking.',
        code: 'CUSTOMER_BOOKING_DISABLED'
      });
    });

    // Handle driver accepting a ride with queue management
    socket.on('driverAcceptRide', async (data) => {
      console.log('\n=== DRIVER ACCEPTING RIDE ===');
      console.log('Driver Socket ID:', socket.id);
      console.log('Driver ID:', socket.user._id);
      console.log('Accept data:', JSON.stringify(data, null, 2));
      
      try {
        const { rideId, driverId, driverName, driverPhone, vehicleDetails } = data;
        
        // Find and update ride request
        const rideRequest = await RideRequest.findById(rideId);
        
        if (!rideRequest) {
          console.error('❌ Ride request not found:', rideId);
          socket.emit('rideAcceptError', { message: 'Ride request not found' });
          return;
        }

        // Allow both 'pending' and 'pending_fm' for Fleet Manager bookings
        if (!['pending', 'pending_fm'].includes(rideRequest.status)) {
          console.error('❌ Ride no longer available:', rideRequest.status);
          socket.emit('rideAcceptError', { message: 'Ride is no longer available' });
          return;
        }

        // Check if manual booking has expired
        if (rideRequest.expiresAt && new Date() > rideRequest.expiresAt) {
          console.error('❌ Manual booking request has expired:', rideRequest.expiresAt);
          // Mark as expired
          rideRequest.status = 'expired';
          rideRequest.isManualBookingExpired = true;
          rideRequest.expiredAt = new Date();
          await rideRequest.save();

          socket.emit('rideExpired', {
            rideId,
            bookingId: rideRequest.bookingId,
            message: 'This ride request has expired. The admin will send a new request.'
          });

          // Notify admin that driver tried to accept expired ride
          io.to('adminRoom').emit('driverTriedExpiredRide', {
            rideId,
            bookingId: rideRequest.bookingId,
            driverId,
            driverName,
            message: `${driverName} tried to accept an expired request`
          });

          return;
        }

        // Get driver details
        const driver = await Driver.findById(driverId);
        
        // Update ride request with driver details
        rideRequest.status = 'driver_assigned';
        rideRequest.driverId = driverId;
        rideRequest.driverName = driverName;
        rideRequest.driverPhone = driverPhone;
        rideRequest.driverVehicleNo = driver?.vehicleNumber || driver?.vehicleNo || 'Unknown';
        rideRequest.driverRating = driver?.rating || 0;
        rideRequest.acceptedAt = new Date();
        await rideRequest.save();
        
        console.log('✅ Ride request updated in database');
        
        // Generate queue number for this accepted ride
        let queueInfo = null;
        const boothName = rideRequest.pickupLocation?.boothName;
        console.log('🎫 [Queue] Booth name from ride request:', boothName);
        
        if (boothName) {
          try {
            console.log('🎫 [Queue] Generating queue number for booth:', boothName);
            queueInfo = await generateQueueNumber(boothName, rideRequest._id);
            console.log('🎫 [Queue] Queue generation result:', queueInfo);
            
            if (queueInfo.success) {
              // Update ride request with queue information
              rideRequest.queueNumber = queueInfo.queueNumber;
              rideRequest.queuePosition = queueInfo.queuePosition;
              rideRequest.queueAssignedAt = new Date();
              rideRequest.queueStatus = 'queued';
              await rideRequest.save();
              
              console.log('✅ Queue number assigned:', queueInfo.queueNumber);
            } else {
              console.warn('⚠️ Queue number generation failed, using fallback:', queueInfo.fallbackQueueNumber);
              rideRequest.queueNumber = queueInfo.fallbackQueueNumber;
              rideRequest.queuePosition = queueInfo.queuePosition;
              rideRequest.queueAssignedAt = new Date();
              rideRequest.queueStatus = 'queued';
              await rideRequest.save();
            }
          } catch (queueError) {
            console.error('❌ Queue number generation error:', queueError);
            // Continue without queue number - don't fail the ride acceptance
          }
        } else {
          console.warn('⚠️ No booth name found, skipping queue number generation');
        }
        
        // Log ride event
        logRideEvent(rideRequest.rideId, 'ride_accepted', {
          driverId,
          driverName,
          vehicleType: rideRequest.vehicleType,
          acceptedAt: new Date(),
          queueNumber: rideRequest.queueNumber,
          queuePosition: rideRequest.queuePosition
        });

        // Prepare acceptance data with OTP info and queue information
        const acceptanceData = {
          rideId: rideRequest._id.toString(),
          uniqueRideId: rideRequest.rideId,
          bookingId: rideRequest.bookingId,
          boothRideNumber: rideRequest.boothRideNumber,
          // Queue information
          queueNumber: rideRequest.queueNumber,
          queuePosition: rideRequest.queuePosition,
          queueStatus: rideRequest.queueStatus,
          queueAssignedAt: rideRequest.queueAssignedAt,
          estimatedWaitTime: queueInfo?.estimatedWaitTime || 0,
          totalInQueue: queueInfo?.totalInQueue || 0,
          boothName: boothName,
          // Driver information
          driverId: driverId,
          driverName: driverName,
          driverPhone: driverPhone,
          vehicleNumber: vehicleDetails?.number || driver?.vehicleNumber || 'Unknown',
          vehicleType: vehicleDetails?.type || rideRequest.vehicleType,
          // OTP information - CRITICAL for production
          startOTP: rideRequest.startOTP,
          endOTP: rideRequest.endOTP,
          // Fare information - Driver sees base fare only
          driverFare: rideRequest.driverFare || rideRequest.fare,
          estimatedFare: rideRequest.driverFare || rideRequest.fare,
          fare: rideRequest.driverFare || rideRequest.fare,
          // Customer fare for user notification (hidden from driver)
          customerFare: rideRequest.customerFare || rideRequest.fare,
          // Status
          status: 'driver_assigned',
          acceptedAt: rideRequest.acceptedAt
        };
        
        // Enhanced logging for production debugging
        console.log('📊 [AcceptanceData] OTP and Fare Status:', {
          hasStartOTP: !!acceptanceData.startOTP,
          hasEndOTP: !!acceptanceData.endOTP,
          startOTP: acceptanceData.startOTP,
          endOTP: acceptanceData.endOTP,
          estimatedFare: acceptanceData.estimatedFare,
          fare: acceptanceData.fare,
          rideId: acceptanceData.rideId
        });

        // Update driver's current ride and REMOVE from queue (driver is now engaged)
        if (driver) {
          const previousQueuePosition = driver.queuePosition;

          await Driver.findByIdAndUpdate(driver._id, {
            currentRide: rideRequest._id,
            isAvailable: false,
            inQueue: false,           // Remove from queue while on ride
            queuePosition: null       // Clear queue position
          });

          console.log(`🚗 Driver ${driver.fullName} is now ENGAGED (removed from queue, was position ${previousQueuePosition})`);

          // Shift other drivers' positions up
          if (previousQueuePosition) {
            await updateQueueAfterDriverRemoval(driver._id);
          }

          // Broadcast driver status change to show "Engaged"
          broadcastStateChange('driverStatusChanged', {
            driverId: driver._id,
            driverName: driver.fullName,
            isOnline: true,
            inQueue: false,
            queuePosition: null,
            currentRide: rideRequest._id,
            connectionStatus: driver.connectionStatus,
            changedBy: 'system',
            reason: 'ride_accepted_engaged',
            timestamp: new Date().toISOString()
          });
        }

        // Notify the accepting driver
        socket.emit('rideAcceptConfirmed', acceptanceData);
        
        // Send queue number to driver
        if (queueInfo && queueInfo.success) {
          socket.emit('queueNumberAssigned', {
            rideId: rideRequest._id.toString(),
            queueNumber: queueInfo.queueNumber,
            queuePosition: queueInfo.queuePosition,
            estimatedWaitTime: queueInfo.estimatedWaitTime,
            totalInQueue: queueInfo.totalInQueue,
            boothName: boothName
          });
        }

        // Prepare customer data with customer fare
        const customerAcceptanceData = {
          ...acceptanceData,
          // Customer sees total fare (customerFare from piecewise formula)
          fare: rideRequest.customerFare || rideRequest.fare,
          estimatedFare: rideRequest.customerFare || rideRequest.estimatedFare
        };

        // Notify the customer with customer fare
        io.to(`user_${rideRequest.userId}`).emit('rideAccepted', customerAcceptanceData);
        
        // Also send queue number to customer
        if (queueInfo && queueInfo.success) {
          io.to(`user_${rideRequest.userId}`).emit('queueNumberAssigned', {
            rideId: rideRequest._id.toString(),
            queueNumber: queueInfo.queueNumber,
            queuePosition: queueInfo.queuePosition,
            estimatedWaitTime: queueInfo.estimatedWaitTime,
            totalInQueue: queueInfo.totalInQueue,
            boothName: boothName
          });
        }

        // Close the ride request to other drivers
        socket.to('drivers').emit('rideRequestClosed', {
          rideId: rideRequest._id.toString()
        });

        // Notify admins
        notifyAdmins('driverAssigned', acceptanceData);

        // If this booking was routed through Fleet Manager, notify the original admin with OTPs
        if (rideRequest.adminId && rideRequest.submittedToFmAt) {
          console.log(`📢 Notifying original admin ${rideRequest.adminName} about driver acceptance (FM flow)`);

          const adminAcceptanceData = {
            ...acceptanceData,
            // Include OTPs for the admin
            startOTP: rideRequest.startOTP,
            endOTP: rideRequest.endOTP,
            assignedByFm: {
              id: rideRequest.assignedByFmId,
              name: rideRequest.assignedByFmName
            },
            customerFare: rideRequest.customerFare || rideRequest.estimatedFare
          };

          // Notify the specific admin who created the booking
          io.to(`admin_${rideRequest.adminId}`).emit('driverAcceptedFmBooking', adminAcceptanceData);

          // Also emit to admin-room for all admins to see
          toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('driverAcceptedFmBooking', adminAcceptanceData);
        }

        console.log('✅ Ride acceptance complete:', {
          rideId: rideRequest._id,
          driverId: driverId,
          queueNumber: rideRequest.queueNumber
        });

      } catch (error) {
        console.error('❌ Error accepting ride:', error);
        socket.emit('rideAcceptError', { 
          message: 'Failed to accept ride',
          error: error.message
        });
      }
    });

    // Handle OTP verification for ride start
    socket.on('verifyStartOTP', async (data, callback) => {
      console.log('\n=== VERIFYING START OTP ===');
      console.log('Requester:', socket.user.role, socket.user._id);
      console.log('Ride ID:', data.rideId);
      console.log('Provided OTP:', data.otp);
      console.log('OTP Type:', typeof data.otp);
      
      try {
        const { rideId, otp } = data;
        
        // Ensure OTP is a string for consistent comparison
        const providedOTP = String(otp).trim();
        
        // Try to find ride by MongoDB ObjectId first, then by rideId field
        let rideRequest = null;
        try {
          rideRequest = await RideRequest.findById(rideId);
          console.log('Found ride by MongoDB ObjectId');
        } catch (error) {
          // If it's not a valid ObjectId, try finding by rideId field
          console.log('Not a valid ObjectId, searching by rideId field...');
          rideRequest = await RideRequest.findOne({ rideId: rideId });
          if (rideRequest) {
            console.log('Found ride by rideId field');
          }
        }
        
        if (!rideRequest) {
          console.error('❌ Ride not found for ID:', rideId);
          const errorResponse = { success: false, message: 'Ride not found' };
          socket.emit('otpVerificationError', errorResponse);
          if (callback) callback(errorResponse);
          return;
        }
        
        // Log ride details for debugging
        console.log('Ride found:', {
          _id: rideRequest._id,
          rideId: rideRequest.rideId,
          status: rideRequest.status,
          startOTP: rideRequest.startOTP,
          startOTPType: typeof rideRequest.startOTP,
          endOTP: rideRequest.endOTP,
          bookingSource: rideRequest.bookingSource
        });
        
        // Ensure stored OTP is also a string
        const storedStartOTP = String(rideRequest.startOTP).trim();
        
        console.log('OTP Comparison:', {
          provided: providedOTP,
          stored: storedStartOTP,
          match: providedOTP === storedStartOTP
        });
        
        // Verify OTP
        if (!verifyOTP(providedOTP, storedStartOTP)) {
          console.error('❌ Invalid start OTP - mismatch');
          const errorResponse = { success: false, message: 'Invalid OTP. Please try again.' };
          socket.emit('otpVerificationError', errorResponse);
          if (callback) callback(errorResponse);
          return;
        }
        
        console.log('✅ Start OTP verified successfully!');
        
        // Update ride status
        rideRequest.status = 'ride_started';
        rideRequest.rideStartedAt = new Date();
        rideRequest.queueStatus = 'in_progress'; // Update queue status
        await rideRequest.save();
        
        console.log('✅ Ride started successfully');
        
        // Log start OTP event
        logRideEvent(rideRequest.rideId, 'ride_started', {
          startedAt: rideRequest.rideStartedAt,
          startOTP: otp,
          verifiedBy: socket.user.role,
          driverId: rideRequest.driverId,
          userId: rideRequest.userId
        });
        
        // Update queue position to in_progress
        if (rideRequest.queueNumber) {
          try {
            await updateQueuePosition(rideRequest._id, 'in_progress');
            console.log('📋 Queue status updated to in_progress');
          } catch (queueError) {
            console.error('❌ Error updating queue status:', queueError);
          }
        }
        
        // Log ride event
        logRideEvent(rideRequest.rideId, 'ride_started', {
          startedAt: new Date(),
          startOTP: otp
        });
        
        // Notify both parties
        const startData = {
          rideId: rideRequest._id.toString(),
          uniqueRideId: rideRequest.rideId,
          boothRideNumber: rideRequest.boothRideNumber,
          status: 'ride_started',
          startedAt: new Date().toISOString(),
          endOTP: rideRequest.endOTP,
          // FIXED: Include fare information for driver earnings display
          driverFare: rideRequest.driverFare || rideRequest.fare,
          fare: rideRequest.driverFare || rideRequest.fare,
          estimatedFare: rideRequest.driverFare || rideRequest.fare
        };
        
        io.to(`user_${rideRequest.userId}`).emit('rideStarted', startData);
        io.to(`driver_${rideRequest.driverId}`).emit('rideStarted', startData);
        
        // Notify admins of ride start
        notifyAdmins('rideStarted', {
          rideId: rideRequest._id.toString(),
          uniqueRideId: rideRequest.rideId,
          userName: rideRequest.userName,
          driverName: rideRequest.driverName,
          pickupLocation: rideRequest.pickupLocation,
          dropLocation: rideRequest.dropLocation,
          status: 'ride_started',
          startedAt: rideRequest.rideStartedAt,
          queueNumber: rideRequest.queueNumber
        });
        
        console.log('📤 Both parties notified of ride start');
        
        const successResponse = {
          success: true,
          message: 'Ride started successfully',
          status: 'ride_started'
        };
        
        socket.emit('otpVerificationSuccess', successResponse);
        if (callback) callback(successResponse);
        
      } catch (error) {
        console.error('❌ Error verifying start OTP:', error);
        const errorResponse = {
          success: false,
          message: 'Failed to verify OTP',
          error: error.message
        };
        socket.emit('otpVerificationError', errorResponse);
        if (callback) callback(errorResponse);
      }
    });

    // Handle driver rejecting a ride
    socket.on('driverRejectRide', async (data, callback) => {
      console.log('\n=== DRIVER REJECTING RIDE ===');
      console.log('Driver Socket ID:', socket.id);
      console.log('Driver ID:', socket.user._id);
      console.log('Reject data:', JSON.stringify(data, null, 2));
      
      try {
        const { rideId, driverId, reason } = data;
        
        // Find the ride request
        const rideRequest = await RideRequest.findById(rideId);
        
        if (!rideRequest) {
          console.error('❌ Ride request not found:', rideId);
          if (callback) callback({ success: false, message: 'Ride request not found' });
          return;
        }
        
        // Check if ride is still pending (allow both 'pending' and 'pending_fm' for Fleet Manager bookings)
        if (!['pending', 'pending_fm'].includes(rideRequest.status)) {
          console.error('❌ Ride is no longer pending:', rideRequest.status);
          if (callback) callback({ success: false, message: 'Ride is no longer available for rejection' });
          return;
        }

        // Check if this is a Fleet Manager flow booking (has submittedToFmAt)
        const isFmFlowBooking = !!rideRequest.submittedToFmAt;

        if (isFmFlowBooking) {
          // FM FLOW: Don't cancel, return to pending_fm for FM to select another driver
          console.log('📋 FM Flow: Returning booking to Fleet Manager queue');

          const previousDriverName = rideRequest.targetDriverName;
          const previousDriverId = rideRequest.targetDriverId;

          rideRequest.status = 'pending_fm';
          rideRequest.targetDriverId = null;
          rideRequest.targetDriverName = null;
          rideRequest.expiresAt = null; // Remove expiry
          rideRequest.isManualBookingExpired = false;
          await rideRequest.save();

          console.log('✅ Booking returned to pending_fm status for FM to reassign');

          // Log the rejection
          logDriverAction(driverId, 'ride_rejected_fm_flow', {
            rideId: rideRequest._id,
            bookingId: rideRequest.bookingId,
            reason: reason || 'Driver not available',
            pickupLocation: rideRequest.pickupLocation?.boothName,
            vehicleType: rideRequest.vehicleType,
            status: 'pending_fm',
            returnedToFmQueue: true
          });

          // Notify the driver of successful rejection
          if (callback) callback({
            success: true,
            message: 'Ride rejected successfully',
            rideId: rideRequest._id,
            status: 'pending_fm'
          });

          // Notify Fleet Manager that driver rejected - booking is back in their queue
          toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('driverRejectedFmBooking', {
            rideId: rideRequest._id,
            bookingId: rideRequest.bookingId,
            rejectedBy: {
              driverId: driverId,
              driverName: socket.user.fullName || previousDriverName || 'Unknown Driver'
            },
            reason: reason || 'Driver not available',
            userName: rideRequest.userName,
            pickupLocation: rideRequest.pickupLocation?.boothName,
            dropLocation: rideRequest.dropLocation?.address,
            vehicleType: rideRequest.vehicleType,
            estimatedFare: rideRequest.estimatedFare,
            status: 'pending_fm',
            message: 'Driver rejected. Please select another driver.',
            timestamp: new Date().toISOString()
          });

          // Also notify the original admin who created the booking
          if (rideRequest.adminId) {
            io.to(`admin_${rideRequest.adminId}`).emit('driverRejectedFmBooking', {
              rideId: rideRequest._id,
              bookingId: rideRequest.bookingId,
              rejectedBy: {
                driverId: driverId,
                driverName: socket.user.fullName || previousDriverName || 'Unknown Driver'
              },
              reason: reason || 'Driver not available',
              status: 'pending_fm',
              timestamp: new Date().toISOString()
            });
          }

          console.log('📤 Fleet Manager notified of ride rejection (booking returned to FM queue)');

        } else {
          // REGULAR FLOW: Cancel the ride as before
          rideRequest.status = 'cancelled';
          rideRequest.cancelledBy = 'driver';
          rideRequest.cancelReason = reason || 'Driver rejected the ride';
          rideRequest.cancelledAt = new Date();
          await rideRequest.save();

          console.log('✅ Ride rejection processed and status updated to cancelled');

          // Log the rejection
          logDriverAction(driverId, 'ride_rejected', {
            rideId: rideRequest._id,
            bookingId: rideRequest.bookingId,
            reason: reason || 'Driver not available',
            pickupLocation: rideRequest.pickupLocation?.boothName,
            vehicleType: rideRequest.vehicleType,
            status: 'cancelled'
          });

          // Notify the driver of successful rejection
          const rejectionResponse = {
            success: true,
            message: 'Ride rejected successfully',
            rideId: rideRequest._id,
            status: 'cancelled'
          };

          if (callback) callback(rejectionResponse);

          // Notify the user that their ride was cancelled
          io.to(`user_${rideRequest.userId}`).emit('rideCancelled', {
            rideId: rideRequest._id,
            bookingId: rideRequest.bookingId,
            reason: 'Driver rejected the ride request',
            cancelledBy: 'driver',
            status: 'cancelled',
            timestamp: new Date().toISOString()
          });

          // Notify admins about the rejection
          notifyAdmins('rideRejectedByDriver', {
            rideId: rideRequest._id,
            bookingId: rideRequest.bookingId,
            driverId: driverId,
            driverName: socket.user.fullName || 'Unknown Driver',
            reason: reason || 'Driver not available',
            userName: rideRequest.userName,
            pickupLocation: rideRequest.pickupLocation?.boothName,
            dropLocation: rideRequest.dropLocation?.address,
            vehicleType: rideRequest.vehicleType,
            estimatedFare: rideRequest.estimatedFare,
            timestamp: new Date().toISOString()
          });

          console.log('📤 Admin notified of ride rejection');
        }
        
      } catch (error) {
        console.error('❌ Error rejecting ride:', error);
        const errorResponse = {
          success: false,
          message: 'Failed to reject ride',
          error: error.message
        };
        if (callback) callback(errorResponse);
      }
    });

    // Handle OTP verification for ride end
    socket.on('verifyEndOTP', async (data, callback) => {
      console.log('\n=== VERIFYING END OTP ===');
      console.log('Requester:', socket.user.role, socket.user._id);
      console.log('Ride ID:', data.rideId);
      console.log('Provided OTP:', data.otp);
      console.log('OTP Type:', typeof data.otp);
      
      try {
        const { rideId, otp } = data;
        
        // Ensure OTP is a string for consistent comparison
        const providedOTP = String(otp).trim();
        
        // Try to find ride by MongoDB ObjectId first, then by rideId field
        let rideRequest = null;
        try {
          rideRequest = await RideRequest.findById(rideId);
          console.log('Found ride by MongoDB ObjectId');
        } catch (error) {
          // If it's not a valid ObjectId, try finding by rideId field
          console.log('Not a valid ObjectId, searching by rideId field...');
          rideRequest = await RideRequest.findOne({ rideId: rideId });
          if (rideRequest) {
            console.log('Found ride by rideId field');
          }
        }
        
        if (!rideRequest) {
          console.error('❌ Ride not found for ID:', rideId);
          const errorResponse = { success: false, message: 'Ride not found' };
          socket.emit('otpVerificationError', errorResponse);
          if (callback) callback(errorResponse);
          return;
        }
        
        // Log ride details for debugging
        console.log('Ride found:', {
          _id: rideRequest._id,
          rideId: rideRequest.rideId,
          status: rideRequest.status,
          startOTP: rideRequest.startOTP,
          endOTP: rideRequest.endOTP,
          endOTPType: typeof rideRequest.endOTP,
          bookingSource: rideRequest.bookingSource
        });
        
        // Ensure stored OTP is also a string
        const storedEndOTP = String(rideRequest.endOTP).trim();
        
        console.log('OTP Comparison:', {
          provided: providedOTP,
          stored: storedEndOTP,
          match: providedOTP === storedEndOTP
        });
        
        // Verify OTP
        if (!verifyOTP(providedOTP, storedEndOTP)) {
          console.error('❌ Invalid end OTP - mismatch');
          const errorResponse = { success: false, message: 'Invalid OTP. Please try again.' };
          socket.emit('otpVerificationError', errorResponse);
          if (callback) callback(errorResponse);
          return;
        }
        
        // Validate driver information before completing
        if (!rideRequest.driverId) {
          console.error('❌ Critical: No driverId found during ride completion');
          const errorResponse = { success: false, message: 'Driver information missing - cannot complete ride' };
          socket.emit('otpVerificationError', errorResponse);
          if (callback) callback(errorResponse);
          return;
        }
        
        // Ensure driver details are populated in the ride request
        if (!rideRequest.driverName || !rideRequest.driverPhone) {
          console.warn('⚠️ Warning: Driver details missing, attempting to fetch from driver record');
          try {
            const driver = await Driver.findById(rideRequest.driverId);
            if (driver) {
              rideRequest.driverName = rideRequest.driverName || driver.fullName;
              rideRequest.driverPhone = rideRequest.driverPhone || driver.mobileNo;
              rideRequest.driverVehicleNo = rideRequest.driverVehicleNo || driver.vehicleNo;
              rideRequest.driverRating = rideRequest.driverRating || driver.rating;
              console.log('✅ Driver details populated from driver record:', {
                driverName: rideRequest.driverName,
                driverPhone: rideRequest.driverPhone,
                driverVehicleNo: rideRequest.driverVehicleNo
              });
            } else {
              console.error('❌ Driver record not found for ID:', rideRequest.driverId);
            }
          } catch (driverFetchError) {
            console.error('❌ Error fetching driver details:', driverFetchError);
          }
        }
        
        // Update ride status to ride_ended first
        rideRequest.status = 'ride_ended';
        rideRequest.rideEndedAt = new Date();
        rideRequest.actualFare = rideRequest.estimatedFare; // For now, use estimated fare
        rideRequest.paymentStatus = 'collected'; // Auto-assume payment collected
        // Keep original paymentMethod from booking (don't override)
        rideRequest.paymentCollectedAt = new Date();
        rideRequest.queueStatus = 'completed'; // Update queue status
        
        // Calculate ride duration
        if (rideRequest.rideStartedAt) {
          const durationMs = rideRequest.rideEndedAt - rideRequest.rideStartedAt;
          rideRequest.rideDuration = Math.floor(durationMs / 60000); // Duration in minutes
        }
        
        await rideRequest.save();
        
        // Clear driver's currentRide and RE-ADD to queue at LAST position
        const driver = await Driver.findById(rideRequest.driverId);
        if (driver) {
          const boothName = driver.currentMetroBooth || rideRequest.pickupLocation;

          // Clear current ride first
          await Driver.findByIdAndUpdate(driver._id, { currentRide: null });

          // Re-add driver to queue at LAST position
          const requeuedDriver = await addDriverBackToQueue(driver._id, boothName);
          if (requeuedDriver) {
            console.log(`🔄 Driver ${driver.fullName} re-added to queue at position ${requeuedDriver.queuePosition}`);
          } else {
            console.log(`⚠️ Could not re-queue driver ${driver.fullName}`);
          }
        }
        
        console.log('✅ Ride ended with driver info:', {
          driverId: rideRequest.driverId,
          driverName: rideRequest.driverName,
          driverPhone: rideRequest.driverPhone,
          driverVehicleNo: rideRequest.driverVehicleNo
        });
        
        console.log('✅ End OTP verified successfully! Ride ending...');
        
        // Remove from queue and update queue positions
        if (rideRequest.queueNumber) {
          try {
            await removeFromQueue(rideRequest._id);
            console.log('📋 Ride removed from queue successfully');
          } catch (queueError) {
            console.error('❌ Error removing from queue:', queueError);
          }
        }
        
        // Log ride event
        logRideEvent(rideRequest.rideId, 'ride_ended', {
          endedAt: new Date(),
          endOTP: otp,
          actualFare: rideRequest.actualFare
        });
        
        // Automatically complete ride using RideLifecycleService
        const completionResult = await RideLifecycleService.completeRide(rideRequest._id, {
          status: 'completed',
          paymentMethod: rideRequest.paymentMethod // Use existing payment method from booking
        });

        if (completionResult.success) {
          console.log('✅ Ride automatically completed and moved to history');

          // Prepare completion notification data
          const completionData = {
            rideId: rideRequest._id.toString(),
            uniqueRideId: rideRequest.rideId,
            boothRideNumber: rideRequest.boothRideNumber,
            status: 'completed',
            endedAt: rideRequest.rideEndedAt.toISOString(),
            completedAt: new Date().toISOString(),
            actualFare: rideRequest.actualFare,
            paymentStatus: 'collected',
            paymentMethod: rideRequest.paymentMethod, // Use existing payment method from booking
            rideDuration: Math.floor((rideRequest.rideEndedAt - rideRequest.rideStartedAt) / 60000), // in minutes
            message: 'Ride completed successfully and moved to history'
          };
          
          // Notify both parties of completion
          // Send different fare data to user and driver
          io.to(`user_${rideRequest.userId}`).emit('rideCompleted', completionData);

          // Driver sees only their earnings (base fare without GST/commission)
          const driverCompletionData = {
            ...completionData,
            fare: rideRequest.driverFare || rideRequest.fare,
            driverFare: rideRequest.driverFare || rideRequest.fare,
            actualFare: rideRequest.driverFare || rideRequest.fare
          };
          io.to(`driver_${rideRequest.driverId}`).emit('rideCompleted', driverCompletionData);
          
          // Notify admins of ride completion
          notifyAdmins('rideCompleted', {
            rideId: rideRequest._id.toString(),
            uniqueRideId: rideRequest.rideId,
            userName: rideRequest.userName,
            driverName: rideRequest.driverName,
            pickupLocation: rideRequest.pickupLocation,
            dropLocation: rideRequest.dropLocation,
            status: 'completed',
            completedAt: completionData.completedAt,
            actualFare: rideRequest.actualFare,
            paymentMethod: rideRequest.paymentMethod,
            queueNumber: rideRequest.queueNumber
          });
          
          console.log('📤 Both parties notified of ride completion');
        } else {
          console.error('❌ Failed to complete ride automatically:', completionResult.error);
          console.error('❌ Ride details that failed:', {
            rideId: rideRequest._id,
            boothRideNumber: rideRequest.boothRideNumber,
            hasDriverId: !!rideRequest.driverId,
            driverName: rideRequest.driverName,
            status: rideRequest.status
          });
          
          // Fallback to old behavior - just notify of ride end
          const endData = {
            rideId: rideRequest._id.toString(),
            uniqueRideId: rideRequest.rideId,
            boothRideNumber: rideRequest.boothRideNumber,
            status: 'ride_ended',
            endedAt: rideRequest.rideEndedAt.toISOString(),
            actualFare: rideRequest.actualFare,
            rideDuration: Math.floor((rideRequest.rideEndedAt - rideRequest.rideStartedAt) / 60000), // in minutes
            // FIXED: Include driver fare information for earnings display
            driverFare: rideRequest.driverFare || rideRequest.fare || rideRequest.actualFare,
            fare: rideRequest.driverFare || rideRequest.fare || rideRequest.actualFare,
            estimatedFare: rideRequest.driverFare || rideRequest.fare || rideRequest.actualFare
          };
          
          io.to(`user_${rideRequest.userId}`).emit('rideEnded', endData);
          io.to(`driver_${rideRequest.driverId}`).emit('rideEnded', endData);
          
          console.log('📤 Fallback: Both parties notified of ride end only');
        }
        
        const successResponse = {
          success: true,
          message: 'Ride completed successfully',
          status: 'ride_ended',
          fare: rideRequest.actualFare
        };
        
        socket.emit('otpVerificationSuccess', successResponse);
        if (callback) callback(successResponse);
        
      } catch (error) {
        console.error('❌ Error verifying end OTP:', error);
        const errorResponse = {
          success: false,
          message: 'Failed to verify OTP',
          error: error.message
        };
        socket.emit('otpVerificationError', errorResponse);
        if (callback) callback(errorResponse);
      }
    });

    // Handle ride cancellation
    socket.on('cancelRide', async (data, callback) => {
      console.log('\n=== RIDE CANCELLATION ===');
      console.log('Requester:', socket.user.role, socket.user._id);
      console.log('Ride ID:', data.rideId);
      console.log('Cancel Data:', data);
      
      try {
        const { rideId, reason } = data;
        
        // Validate rideId
        if (!rideId) {
          console.error('❌ No ride ID provided');
          if (callback) callback({ success: false, message: 'Ride ID is required for cancellation' });
          return;
        }
        
        console.log('🔍 Looking for ride with ID:', rideId);
        
        // First try to find by MongoDB _id
        let rideRequest = await RideRequest.findById(rideId);
        
        // If not found by _id, try to find by custom rideId field
        if (!rideRequest) {
          console.log('🔍 Not found by _id, trying custom rideId field...');
          rideRequest = await RideRequest.findOne({ rideId: rideId });
        }
        
        // If still not found, try uniqueRideId field (legacy support)
        if (!rideRequest) {
          console.log('🔍 Not found by rideId field, trying uniqueRideId field...');
          rideRequest = await RideRequest.findOne({ uniqueRideId: rideId });
        }

        // Try finding by bookingId for manual bookings
        if (!rideRequest) {
          console.log('🔍 Not found by uniqueRideId, trying bookingId field...');
          rideRequest = await RideRequest.findOne({ bookingId: rideId });
        }

        if (!rideRequest) {
          console.error('❌ Ride not found with any ID format');
          console.log('❌ Tried searching for:', rideId);
          console.log('❌ ID type:', typeof rideId, 'Length:', rideId?.length);
          console.log('❌ Searched fields: _id, rideId, uniqueRideId, bookingId');

          // Log a sample ride to see the structure
          const sampleRide = await RideRequest.findOne({}).limit(1);
          if (sampleRide) {
            console.log('📋 Sample ride structure:', {
              _id: sampleRide._id?.toString(),
              rideId: sampleRide.rideId,
              uniqueRideId: sampleRide.uniqueRideId,
              bookingId: sampleRide.bookingId
            });
          }

          if (callback) callback({ success: false, message: 'Ride not found' });
          return;
        }
        
        console.log('✅ Found ride:', rideRequest._id, 'Status:', rideRequest.status);
        
        // Update ride status
        rideRequest.status = 'cancelled';
        rideRequest.cancelledAt = new Date();
        rideRequest.cancellationReason = reason || 'No reason provided';
        rideRequest.cancelledBy = socket.user.role;
        rideRequest.queueStatus = 'completed'; // Mark queue as completed when cancelled
        await rideRequest.save();
        
        console.log('✅ Ride cancelled in database');
        
        // Remove from queue if it was in queue
        if (rideRequest.queueNumber) {
          try {
            await removeFromQueue(rideRequest._id);
            console.log('📋 Cancelled ride removed from queue successfully');
          } catch (queueError) {
            console.error('❌ Error removing cancelled ride from queue:', queueError);
          }
        }
        
        // Clear driver's currentRide field and RE-ADD to queue if ride was assigned
        if (rideRequest.driverId) {
          try {
            const driver = await Driver.findById(rideRequest.driverId);
            if (driver && driver.currentRide && driver.currentRide.toString() === rideRequest._id.toString()) {
              const boothName = driver.currentMetroBooth || rideRequest.pickupLocation;

              // Clear current ride first
              await Driver.findByIdAndUpdate(driver._id, { currentRide: null });

              // Re-add driver to queue at LAST position
              const requeuedDriver = await addDriverBackToQueue(driver._id, boothName);
              if (requeuedDriver) {
                console.log(`🔄 Driver ${driver.fullName} re-added to queue at position ${requeuedDriver.queuePosition} after cancellation`);
              } else {
                console.log(`⚠️ Could not re-queue driver ${driver.fullName} after cancellation`);
              }
            }
          } catch (driverError) {
            console.error('❌ Error clearing driver currentRide field:', driverError);
          }
        }
        
        // Log ride event
        logRideEvent(rideRequest.rideId, 'ride_cancelled', {
          cancelledBy: socket.user.role,
          reason: reason,
          cancelledAt: new Date()
        });
        
        // Notify both parties
        if (socket.user.role === 'driver') {
          // Driver cancelled - notify user
          io.to(`user_${rideRequest.userId}`).emit('rideCancelled', {
            rideId: rideId,
            uniqueRideId: rideRequest.rideId,
            bookingId: rideRequest.bookingId,
            cancelledBy: 'driver',
            reason: reason
          });
          console.log('📤 User notified of cancellation');

          // ALSO notify the driver themselves to clear their UI
          socket.emit('rideCancelled', {
            rideId: rideId,
            uniqueRideId: rideRequest.rideId,
            bookingId: rideRequest.bookingId,
            cancelledBy: 'driver',
            reason: reason,
            success: true
          });
          console.log('📤 Driver notified of own cancellation');
        } else {
          // User cancelled - notify driver
          if (rideRequest.driverId) {
            io.to(`driver_${rideRequest.driverId}`).emit('rideCancelled', {
              rideId: rideId,
              uniqueRideId: rideRequest.rideId,
              bookingId: rideRequest.bookingId,
              cancelledBy: 'user',
              reason: reason
            });
            console.log('📤 Driver notified of cancellation');
          }
        }
        
        // Notify admins of ride cancellation
        notifyAdmins('rideCancelled', {
          rideId: rideRequest._id.toString(),
          uniqueRideId: rideRequest.rideId,
          bookingId: rideRequest.bookingId, // Added for manual booking matching
          userName: rideRequest.userName,
          driverName: rideRequest.driverName || 'No driver assigned',
          pickupLocation: rideRequest.pickupLocation,
          dropLocation: rideRequest.dropLocation,
          status: 'cancelled',
          cancelledAt: rideRequest.cancelledAt,
          cancelledBy: socket.user.role,
          reason: reason,
          queueNumber: rideRequest.queueNumber
        });
        
        // Send callback acknowledgment
        if (callback) {
          callback({
            success: true,
            message: 'Ride cancelled successfully'
          });
        }
        
      } catch (error) {
        console.error('❌ Error cancelling ride:', error);
        if (callback) {
          callback({
            success: false,
            message: 'Failed to cancel ride',
            error: error.message
          });
        }
      }
    });

    // Handle payment collection and ride completion
    socket.on('collectPayment', async (data, callback) => {
      console.log('\n=== PAYMENT COLLECTION ===');
      console.log('Requester:', socket.user.role, socket.user._id);
      console.log('Data:', data);
      
      try {
        const { rideId, paymentMethod, actualFare, userRating, driverRating } = data;
        
        // Try to find ride by MongoDB ObjectId first, then by rideId field
        let rideRequest = null;
        try {
          rideRequest = await RideRequest.findById(rideId);
        } catch (error) {
          console.log('Not a valid ObjectId, searching by rideId field...');
          rideRequest = await RideRequest.findOne({ rideId: rideId });
        }
        
        if (!rideRequest) {
          console.error('❌ Ride not found');
          const errorResponse = { success: false, message: 'Ride not found' };
          if (callback) callback(errorResponse);
          return;
        }
        
        // Verify ride is in ended state
        if (rideRequest.status !== 'ride_ended') {
          console.error('❌ Ride is not in ended state');
          const errorResponse = { success: false, message: 'Ride must be ended before payment collection' };
          if (callback) callback(errorResponse);
          return;
        }
        
        // Update payment information
        rideRequest.paymentStatus = 'collected';
        // Only update paymentMethod if explicitly provided, otherwise keep original from booking
        if (paymentMethod) {
          rideRequest.paymentMethod = paymentMethod;
        }
        rideRequest.paymentCollectedAt = new Date();
        rideRequest.actualFare = actualFare || rideRequest.estimatedFare;
        rideRequest.status = 'completed';
        await rideRequest.save();
        
        console.log('✅ Payment collected and ride marked as completed');
        
        // Prepare completion data for lifecycle service
        const completionData = {
          status: 'completed',
          userRating: userRating ? {
            rating: userRating.rating,
            feedback: userRating.feedback,
            ratedAt: new Date()
          } : null,
          driverRatingForUser: driverRating ? {
            rating: driverRating.rating,
            feedback: driverRating.feedback,
            ratedAt: new Date()
          } : null
        };
        
        // Move ride to history using lifecycle service
        const lifecycleResult = await RideLifecycleService.completeRide(
          rideRequest._id.toString(), 
          completionData
        );
        
        if (lifecycleResult.success) {
          console.log('✅ Ride successfully moved to history');
          
          // Notify both parties of completion
          const completionNotification = {
            rideId: rideRequest._id.toString(),
            uniqueRideId: rideRequest.rideId,
            boothRideNumber: rideRequest.boothRideNumber,
            status: 'completed',
            actualFare: rideRequest.actualFare,
            paymentMethod: rideRequest.paymentMethod,
            completedAt: new Date().toISOString()
          };
          
          // User sees full fare
          io.to(`user_${rideRequest.userId}`).emit('rideCompleted', completionNotification);

          // Driver sees only their earnings
          const driverCompletionNotification = {
            ...completionNotification,
            actualFare: rideRequest.driverFare || rideRequest.fare || rideRequest.actualFare,
            fare: rideRequest.driverFare || rideRequest.fare || rideRequest.actualFare,
            driverFare: rideRequest.driverFare || rideRequest.fare || rideRequest.actualFare
          };
          io.to(`driver_${rideRequest.driverId}`).emit('rideCompleted', driverCompletionNotification);
          
          console.log('📤 Both parties notified of ride completion');
          
          const successResponse = {
            success: true,
            message: 'Payment collected and ride completed successfully',
            rideId: rideRequest._id.toString(),
            actualFare: rideRequest.actualFare,
            status: 'completed'
          };
          
          if (callback) callback(successResponse);
          
        } else {
          console.error('❌ Failed to move ride to history:', lifecycleResult.error);
          const errorResponse = {
            success: false,
            message: 'Payment collected but failed to finalize ride completion',
            error: lifecycleResult.error
          };
          if (callback) callback(errorResponse);
        }
        
      } catch (error) {
        console.error('❌ Error collecting payment:', error);
        const errorResponse = {
          success: false,
          message: 'Failed to collect payment',
          error: error.message
        };
        if (callback) callback(errorResponse);
      }
    });
    
    // Handle ride completion with cancellation (using lifecycle service)
    socket.on('completeRideWithCancellation', async (data, callback) => {
      console.log('\n=== COMPLETING RIDE WITH CANCELLATION ===');
      console.log('Requester:', socket.user.role, socket.user._id);
      console.log('Data:', data);
      
      try {
        const { rideId, reason } = data;
        
        // Use lifecycle service to cancel ride
        const lifecycleResult = await RideLifecycleService.cancelRide(rideId, {
          reason: reason || 'No reason provided',
          cancelledBy: socket.user.role
        });
        
        if (lifecycleResult.success) {
          console.log('✅ Ride cancelled and moved to history');
          
          // Notify both parties
          const cancellationNotification = {
            rideId: rideId,
            status: 'cancelled',
            reason: reason,
            cancelledBy: socket.user.role,
            cancelledAt: new Date().toISOString()
          };
          
          // Find the ride to get user and driver IDs for notification
          const rideHistory = lifecycleResult.rideHistory;
          if (rideHistory) {
            io.to(`user_${rideHistory.userId}`).emit('rideCancelled', cancellationNotification);
            if (rideHistory.driverId) {
              io.to(`driver_${rideHistory.driverId}`).emit('rideCancelled', cancellationNotification);
            }
          }
          
          const successResponse = {
            success: true,
            message: 'Ride cancelled and moved to history successfully'
          };
          
          if (callback) callback(successResponse);
          
        } else {
          console.error('❌ Failed to cancel ride:', lifecycleResult.error);
          const errorResponse = {
            success: false,
            message: 'Failed to cancel ride',
            error: lifecycleResult.error
          };
          if (callback) callback(errorResponse);
        }
        
      } catch (error) {
        console.error('❌ Error cancelling ride:', error);
        const errorResponse = {
          success: false,
          message: 'Failed to cancel ride',
          error: error.message
        };
        if (callback) callback(errorResponse);
      }
    });

    // Enhanced driver location updates with logging
    socket.on('updateDriverLocation', async (data) => {
      console.log('\n=== DRIVER LOCATION UPDATE ===');
      console.log('Driver ID:', socket.user._id);
      console.log('Location:', data.location);
      console.log('Ride ID:', data.rideId);
      console.log('Timestamp:', data.timestamp);
      
      try {
        const { location, rideId, bearing, speed } = data;
        
        // Update driver's location in database
        await Driver.findByIdAndUpdate(socket.user._id, {
          currentLocation: location,
          lastLocationUpdate: new Date(),
          currentBearing: bearing,
          currentSpeed: speed
        });

        // If there's an active ride, notify the user with enhanced data
        if (rideId) {
          // Try to find ride by MongoDB ObjectId first, then by rideId field
          let rideRequest = null;
          try {
            rideRequest = await RideRequest.findById(rideId);
          } catch (error) {
            // If it's not a valid ObjectId, try finding by rideId field
            console.log('Not a valid ObjectId, searching by rideId field...');
            rideRequest = await RideRequest.findOne({ rideId: rideId });
          }
          
          if (rideRequest && rideRequest.userId) {
            const locationUpdate = {
              rideId,
              location,
              bearing,
              speed,
              timestamp: new Date().toISOString()
            };
            
            io.to(`user_${rideRequest.userId}`).emit('driverLocationUpdated', locationUpdate);
            console.log('✅ Location update sent to user');
          }
        }
      } catch (error) {
        console.error('❌ Error updating driver location:', error);
        socket.emit('locationUpdateError', {
          message: 'Failed to update location',
          error: error.message
        });
      }
    });

    // Add debug endpoint to provide room membership info
    socket.on('getRoomInfo', () => {
      const rooms = Array.from(socket.rooms);
      const driversRoom = io.sockets.adapter.rooms.get('drivers');
      const driversCount = driversRoom ? driversRoom.size : 0;

      socket.emit('roomInfo', {
        socketId: socket.id,
        userId: socket.user._id,
        role: socket.user.role,
        rooms: rooms,
        driversOnline: driversCount,
        inDriversRoom: rooms.includes('drivers')
      });
    });

    // Handle disconnection
    socket.on('disconnect', async (reason) => {
      console.log('\n=== CLIENT DISCONNECTED ===');
      console.log('Socket ID:', socket.id);
      console.log('User ID:', socket.user._id);
      console.log('Role:', socket.user.role);
      console.log('Reason:', reason);
      console.log('Time:', new Date().toISOString());

      // Remove from connected clients map
      connectedClients.delete(socket.user._id);
      console.log(`✅ Client ${socket.user._id} removed from connected clients map`);

      // Update driver status if it's a driver
      if (socket.user.role === 'driver') {
        try {
          // Get driver's current state to check queue membership
          const driver = await Driver.findById(socket.user._id);

          if (driver) {
            // Determine new connection status based on queue membership
            const newConnectionStatus = driver.inQueue ? 'disconnected' : 'offline';

            // Update connection status but PRESERVE queue position
            await Driver.findByIdAndUpdate(socket.user._id, {
              isOnline: false,
              lastActiveTime: new Date(),
              connectionStatus: newConnectionStatus
              // NOTE: queuePosition and inQueue are NOT cleared here!
            });

            console.log(`📊 Driver ${driver.fullName} disconnected:`);
            console.log(`   - Still in queue: ${driver.inQueue}`);
            console.log(`   - Queue position: ${driver.queuePosition}`);
            console.log(`   - Connection status: ${newConnectionStatus}`);

            // Broadcast status change to admins
            if (driver.inQueue) {
              // Driver is in queue but disconnected - notify as "Not Reachable"
              notifyAdmins('driverNotReachable', {
                driverId: socket.user._id,
                driverName: driver.fullName,
                queuePosition: driver.queuePosition,
                metroBooth: driver.currentMetroBooth,
                vehicleType: driver.vehicleType,
                lastActiveTime: new Date().toISOString(),
                timestamp: new Date().toISOString(),
                reason: reason
              });

              broadcastStateChange('driverStatusChanged', {
                driverId: socket.user._id,
                driverName: driver.fullName,
                isOnline: false,
                inQueue: true,
                queuePosition: driver.queuePosition,
                connectionStatus: 'disconnected',
                currentPickupLocation: driver.currentMetroBooth,
                lastActiveTime: new Date().toISOString(),
                changedBy: 'system',
                reason: 'socket_disconnect',
                timestamp: new Date().toISOString()
              });

              console.log(`⚠️  Driver ${driver.fullName} is NOT REACHABLE but remains in queue at position #${driver.queuePosition}`);
            } else {
              // Driver was not in queue anyway
              console.log(`ℹ️  Driver ${driver.fullName} went offline (was not in queue)`);

              // Still broadcast for UI updates
              broadcastStateChange('driverStatusChanged', {
                driverId: socket.user._id,
                driverName: driver.fullName,
                isOnline: false,
                inQueue: false,
                queuePosition: null,
                connectionStatus: 'offline',
                currentPickupLocation: null,
                lastActiveTime: new Date().toISOString(),
                changedBy: 'system',
                reason: 'socket_disconnect',
                timestamp: new Date().toISOString()
              });
            }
          }
        } catch (err) {
          console.error('❌ Error updating driver status on disconnect:', err);
        }
      }
    });

    // Error handling
    socket.on('error', (error) => {
      console.error('\n=== SOCKET ERROR ===');
      console.error('Socket ID:', socket.id);
      console.error('Error:', error);
    });
  });

  // Global error handler
  io.on('error', (error) => {
    console.error('\n=== SOCKET.IO SERVER ERROR ===');
    console.error('Error:', error);
  });

  // Initialize enhanced notification service
  enhancedNotificationService = new EnhancedNotificationService(io);
  console.log('✅ Enhanced notification service initialized');
  
  // Initialize ride completion service
  rideCompletionService = new RideCompletionService(enhancedNotificationService);
  console.log('✅ Ride completion service initialized');
  
  console.log('✅ Socket.IO server initialized successfully\n');
};

// Get IO instance
const getIO = () => {
  if (!io) {
    console.error('Socket.IO not initialized');
    throw new Error('Socket.IO not initialized');
  }
  return io;
};

// Enhanced function to notify admins of ride events
const notifyAdmins = (eventType, data, options = {}) => {
  if (!enhancedNotificationService) {
    console.warn('Enhanced notification service not initialized - falling back to basic notification');
    // Fallback to basic notification
    if (io) {
      io.to('admins').emit('rideUpdate', {
        type: eventType,
        data: data,
        timestamp: new Date().toISOString()
      });
      io.to('admins').emit(eventType, data);
    }
    return;
  }
  
  return enhancedNotificationService.notifyAdmins(eventType, data, options);
};

// Standalone function to broadcast ride requests to available drivers
const broadcastRideRequest = async (rideRequest) => {
  console.log('\n=== BROADCASTING RIDE REQUEST ===');
  console.log('Ride ID:', rideRequest._id);
  console.log('Pickup:', rideRequest.pickupLocation?.boothName);
  console.log('Vehicle Type:', rideRequest.vehicleType);
  
  const io = getIO();
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return { 
      success: false, 
      error: 'Socket service not available',
      driversNotified: 0
    };
  }

  try {
    // Prepare ride data for broadcast
    // IMPORTANT: Drivers see base fare, customers see total with commission
    const rideDataForDriver = {
      _id: rideRequest._id,
      rideId: rideRequest.rideId,
      pickupLocation: {
        boothName: rideRequest.pickupLocation.boothName,
        latitude: rideRequest.pickupLocation.latitude,
        longitude: rideRequest.pickupLocation.longitude
      },
      dropLocation: {
        address: rideRequest.dropLocation.address,
        latitude: rideRequest.dropLocation.latitude,
        longitude: rideRequest.dropLocation.longitude
      },
      vehicleType: rideRequest.vehicleType,
      // Drivers see only their earning (driverFare), never customerTotalFare
      driverFare: rideRequest.driverFare || rideRequest.fare || 0,
      estimatedFare: rideRequest.driverFare || rideRequest.fare || 0,
      fare: rideRequest.driverFare || rideRequest.fare || 0,
      distance: rideRequest.distance,
      startOTP: rideRequest.startOTP,
      endOTP: rideRequest.endOTP,  // Include endOTP if available
      userName: rideRequest.userName,
      userPhone: rideRequest.userPhone,
      status: 'pending',
      timestamp: rideRequest.timestamp || new Date()
    };

    // Data for admin includes full breakdown
    const rideDataForAdmin = {
      ...rideDataForDriver,
      // Admin sees everything
      customerFare: rideRequest.customerFare || rideRequest.fare,
      driverFare: rideRequest.driverFare || rideRequest.fare, // FIXED: Use correct driverFare field
      gstAmount: rideRequest.gstAmount || 0,
      commissionAmount: rideRequest.commissionAmount || 0,
      nightChargeAmount: rideRequest.nightChargeAmount || 0,
      fareBreakdown: rideRequest.fareBreakdown
    };

    // Use driver data as default
    const rideData = rideDataForDriver;
    
    // Enhanced logging for production debugging
    console.log('📊 [BroadcastRideRequest] Data being sent:', {
      hasStartOTP: !!rideData.startOTP,
      hasEndOTP: !!rideData.endOTP,
      startOTP: rideData.startOTP,
      endOTP: rideData.endOTP,
      estimatedFare: rideData.estimatedFare,
      fare: rideData.fare
    });

    // Broadcast to all drivers
    const driversRoom = io.sockets.adapter.rooms.get('drivers');
    const driversInRoom = driversRoom ? driversRoom.size : 0;
    
    console.log(`📢 Broadcasting to ${driversInRoom} drivers in 'drivers' room`);
    io.to('drivers').emit('newRideRequest', rideData);

    // Also broadcast to admin room for monitoring
    const adminRoom = io.sockets.adapter.rooms.get('admin-room');
    const adminsInRoom = adminRoom ? adminRoom.size : 0;
    
    console.log(`📢 Broadcasting to ${adminsInRoom} admins in 'admin-room'`);
    toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('customerRideRequest', {
      ...rideDataForAdmin, // Admin gets full breakdown
      message: 'New customer ride request',
      needsAssignment: true
    });

    // Find online drivers at the pickup station and notify them specifically
    const Driver = require('./models/Driver');
    const onlineDrivers = await Driver.find({
      isOnline: true,
      currentMetroBooth: rideRequest.pickupLocation.boothName,
      vehicleType: rideRequest.vehicleType,
      currentRide: null
    }).select('_id fullName');

    console.log(`🎯 Found ${onlineDrivers.length} eligible drivers at ${rideRequest.pickupLocation.boothName}`);
    
    // Send targeted notifications to eligible drivers
    let targetedNotifications = 0;
    for (const driver of onlineDrivers) {
      const driverRoom = `driver_${driver._id}`;
      io.to(driverRoom).emit('newRideRequest', {
        ...rideData,
        targetedNotification: true,
        message: `New ride request at your station: ${rideRequest.pickupLocation.boothName}`
      });
      targetedNotifications++;
    }

    console.log(`✅ Ride broadcast completed:`);
    console.log(`   - Drivers room: ${driversInRoom} connections`);
    console.log(`   - Admin room: ${adminsInRoom} connections`);
    console.log(`   - Targeted notifications: ${targetedNotifications} drivers`);

    return { 
      success: true, 
      driversNotified: Math.max(driversInRoom, targetedNotifications),
      adminsNotified: adminsInRoom,
      broadcastMethod: 'socket',
      eligibleDrivers: onlineDrivers.map(d => ({ id: d._id, name: d.fullName }))
    };

  } catch (error) {
    console.error('❌ Error broadcasting ride request:', error);
    return { 
      success: false, 
      error: error.message,
      driversNotified: 0
    };
  }
};

// Export function to get services for admin tools
const getServices = () => ({
  enhancedNotificationService,
  rideCompletionService,
  io
});

// Function to send a ride request to one specific driver (direct manual bookings and Fleet Manager assignments).
// Returns success: true only when the driver's app confirmed that it received the request. If it did not
// (driver disconnected, or a stale connection that never answered) the request stays assigned to the driver and
// is delivered as soon as their app is connected again (see deliverPendingRequests), so callers treat
// success: false as "queued, waiting for the driver", not as a lost request.
const sendRideRequestToDriver = async (rideRequest, driverId) => {
  console.log('\n=== SENDING RIDE REQUEST TO SPECIFIC DRIVER ===');
  console.log('Ride ID:', rideRequest._id);
  console.log('Target Driver ID:', driverId);
  console.log('Pickup:', rideRequest.pickupLocation?.boothName);
  console.log('Vehicle Type:', rideRequest.vehicleType);

  const io = getIO();
  if (!io) {
    console.error('❌ Socket.IO not initialized');
    return {
      success: false,
      error: 'Socket service not available',
      driverNotified: false
    };
  }

  try {
    const rideData = buildDriverRidePayload(rideRequest);
    const driverIdString = driverId.toString();
    const driverRoom = `driver_${driverIdString}`;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Every live connection of this driver (briefly a driver can have a stale and a fresh one at once)
    const findDriverSockets = () => {
      const found = [];
      for (const [, socket] of io.sockets.sockets) {
        if (socket.user && socket.user.role === 'driver' && socket.user._id.toString() === driverIdString) {
          found.push(socket);
        }
      }
      return found;
    };

    // Sends to all of them; true as soon as one driver app confirms, false when nobody confirms in time
    const sendAndWaitForConfirmation = (sockets, timeoutMs) => new Promise((resolve) => {
      let settled = false;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(confirmed);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);

      for (const socket of sockets) {
        if (!socket.rooms.has(driverRoom)) socket.join(driverRoom);
        if (!socket.confirmedRequestIds) socket.confirmedRequestIds = new Set();
        socket.emit('newRideRequest', rideData, (ack) => {
          console.log('✅ Driver acknowledged ride request:', ack);
          socket.confirmedRequestIds.add(String(rideRequest._id));
          finish(true);
        });
      }
    });

    // A driver that is a moment away from reconnecting gets two more chances before we give up waiting
    const waitsBeforeAttempt = [0, 1000, 1500];
    let liveConnections = 0;
    for (let attempt = 1; attempt <= waitsBeforeAttempt.length; attempt++) {
      if (waitsBeforeAttempt[attempt - 1]) await sleep(waitsBeforeAttempt[attempt - 1]);

      const sockets = findDriverSockets();
      console.log(`📤 Attempt ${attempt}/${waitsBeforeAttempt.length}: ${sockets.length} live connection(s) for driver ${driverIdString}`);
      if (sockets.length === 0) continue;

      liveConnections = sockets.length;
      const confirmed = await sendAndWaitForConfirmation(sockets, 4000);
      if (confirmed) {
        await markDriverNotified(rideRequest._id);
        const roomSize = io.sockets.adapter.rooms.get(driverRoom)?.size || 0;
        console.log(`✅ Ride request delivered to driver ${driverIdString} (attempt ${attempt}, ${roomSize} connection(s) in ${driverRoom})`);

        toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('manualBookingSentToDriver', {
          rideId: rideRequest._id,
          bookingId: rideRequest.bookingId,
          driverId: driverIdString,
          status: 'pending',
          timestamp: new Date(),
          attempt
        });

        return {
          success: true,
          driverNotified: true,
          driverId: driverIdString,
          method: 'direct_socket_acknowledged',
          driverSocketFound: true,
          roomSize,
          attempt
        };
      }

      // Connections exist but none answered: they are stale (the real device is gone or reconnecting).
      // Waiting longer here would not help, the request is delivered when the app reconnects.
      console.warn(`⚠️ ${liveConnections} connection(s) found for driver ${driverIdString} but none confirmed the request`);
      break;
    }

    console.warn(`⏳ Ride request ${rideRequest.bookingId} is waiting for driver ${driverIdString} to reconnect`);
    const reason = liveConnections > 0
      ? 'Driver app is not reachable (no confirmation) - the request will be delivered when it reconnects'
      : 'Driver not online - not reachable right now; the request will be delivered when the driver reconnects';

    toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('manualBookingFailedToSend', {
      rideId: rideRequest._id,
      bookingId: rideRequest.bookingId,
      driverId: driverIdString,
      error: 'Driver not online or not reachable',
      willRetryOnReconnect: true,
      timestamp: new Date()
    });

    return {
      success: false,
      driverNotified: false,
      queued: true,
      driverSocketFound: liveConnections > 0,
      driverId: driverIdString,
      error: reason
    };

  } catch (error) {
    console.error('❌ Error sending ride request to driver:', error);
    return {
      success: false,
      error: error.message,
      driverNotified: false
    };
  }
};

module.exports = {
  initializeSocket,
  getIO,
  broadcastRideRequest,
  sendRideRequestToDriver,
  notifyAdmins,
  getServices
};