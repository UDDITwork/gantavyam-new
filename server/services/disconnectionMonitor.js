/**
 * Disconnection Monitor Service
 * Monitors drivers who have been disconnected for too long
 * and automatically removes them from the queue (only if no active ride)
 */
const Driver = require('../models/Driver');
const MetroStation = require('../models/MetroStation');
const RideRequest = require('../models/RideRequest');

// Configuration
const TIMEOUT_MINUTES = 30; // Remove driver after 30 minutes of disconnection
const CHECK_INTERVAL_MS = 60 * 1000; // Check every 1 minute
const MANUAL_BOOKING_CHECK_INTERVAL_MS = 5 * 1000; // Check expired manual bookings every 5 seconds

// Socket.io reference (set by server initialization)
let io = null;

/**
 * Set the socket.io instance for notifications
 * @param {Object} socketIO - Socket.io instance
 */
function setIO(socketIO) {
  io = socketIO;
}

/**
 * Get the socket.io instance
 * @returns {Object} Socket.io instance
 */
function getIO() {
  return io;
}

/**
 * Check for drivers who have been disconnected too long
 *
 * NOTE: Auto-removal is DISABLED as of Jan 20, 2026
 * Admin-Only Queue Management: Drivers stay in queue as "Not Reachable" (yellow)
 * until admin manually removes them using "Remove from Queue" button.
 *
 * This function now only cleans up expired online/offline requests.
 */
async function checkDisconnectedDrivers() {
  try {
    // AUTO-REMOVAL DISABLED - Admin controls queue membership
    // Disconnected drivers stay in queue as "Not Reachable" (yellow status)
    // Admin can manually remove drivers using "Remove from Queue" button
    console.log('[DisconnectionMonitor] Auto-removal DISABLED - admin controls queue');

    // Still clean up expired online/offline requests
    await cleanupExpiredRequests();

  } catch (error) {
    console.error('❌ Error in disconnection monitor:', error);
  }
}

/**
 * Remove a driver from the queue due to disconnection timeout
 * @param {Object} driver - Driver document
 */
async function removeDriverFromQueue(driver) {
  try {
    console.log(`\n⏰ Removing driver due to disconnection timeout:`);
    console.log(`   - Name: ${driver.fullName}`);
    console.log(`   - ID: ${driver._id}`);
    console.log(`   - Booth: ${driver.currentMetroBooth}`);
    console.log(`   - Last active: ${driver.lastActiveTime?.toISOString()}`);

    const previousBooth = driver.currentMetroBooth;

    // Update driver status
    await Driver.findByIdAndUpdate(driver._id, {
      isOnline: false,
      inQueue: false,
      connectionStatus: 'offline',
      queuePosition: null,
      queueEntryTime: null,
      currentMetroBooth: null
    });

    // Update metro station online drivers count
    if (previousBooth) {
      const metroStation = await MetroStation.findOne({ name: previousBooth });
      if (metroStation) {
        await metroStation.decrementOnlineDrivers();
      }
    }

    console.log(`✅ Driver ${driver.fullName} removed from queue due to timeout`);

    // Notify admins via socket
    if (io) {
      io.to('admins').emit('driverTimeoutRemoved', {
        driverId: driver._id,
        driverName: driver.fullName,
        driverPhone: driver.mobileNo,
        previousBooth: previousBooth,
        lastActiveTime: driver.lastActiveTime,
        reason: `${TIMEOUT_MINUTES}-minute disconnection timeout`,
        timestamp: new Date().toISOString()
      });

      // Also emit driver status change
      io.to('admins').emit('driverStatusChanged', {
        driverId: driver._id,
        driverName: driver.fullName,
        isOnline: false,
        inQueue: false,
        connectionStatus: 'offline',
        changedBy: 'system',
        reason: 'disconnection_timeout',
        timestamp: new Date().toISOString()
      });
    }

    // Notify the driver (if they reconnect, they'll see this)
    if (io) {
      io.to(`driver_${driver._id}`).emit('removedFromQueue', {
        reason: 'disconnection_timeout',
        message: `You were removed from the queue after ${TIMEOUT_MINUTES} minutes of being disconnected. Please go online again.`,
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error(`❌ Error removing driver ${driver._id}:`, error);
  }
}

/**
 * Clean up expired online and offline requests
 */
async function cleanupExpiredRequests() {
  try {
    const DriverOnlineRequest = require('../models/DriverOnlineRequest');
    const DriverOfflineRequest = require('../models/DriverOfflineRequest');

    // Find and update expired pending ONLINE requests
    const result = await DriverOnlineRequest.updateMany(
      {
        status: 'pending',
        expiresAt: { $lt: new Date() }
      },
      {
        $set: {
          status: 'expired',
          processedAt: new Date()
        }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`🧹 Cleaned up ${result.modifiedCount} expired online requests`);

      // Clear pending request references from drivers
      await Driver.updateMany(
        { pendingOnlineRequest: { $ne: null } },
        [
          {
            $lookup: {
              from: 'driveronlinerequests',
              localField: 'pendingOnlineRequest',
              foreignField: '_id',
              as: 'requestInfo'
            }
          }
        ]
      );

      // Simple approach: clear all pendingOnlineRequest that reference expired requests
      const expiredRequests = await DriverOnlineRequest.find({ status: 'expired' }).select('_id');
      const expiredIds = expiredRequests.map(r => r._id);

      await Driver.updateMany(
        { pendingOnlineRequest: { $in: expiredIds } },
        { $set: { pendingOnlineRequest: null } }
      );
    }

    // Find and update expired pending OFFLINE requests
    const offlineResult = await DriverOfflineRequest.updateMany(
      {
        status: 'pending',
        expiresAt: { $lt: new Date() }
      },
      {
        $set: {
          status: 'expired',
          processedAt: new Date()
        }
      }
    );

    if (offlineResult.modifiedCount > 0) {
      console.log(`🧹 Cleaned up ${offlineResult.modifiedCount} expired offline requests`);

      // Clear all pendingOfflineRequest that reference expired requests
      const expiredOfflineRequests = await DriverOfflineRequest.find({ status: 'expired' }).select('_id');
      const expiredOfflineIds = expiredOfflineRequests.map(r => r._id);

      await Driver.updateMany(
        { pendingOfflineRequest: { $in: expiredOfflineIds } },
        { $set: { pendingOfflineRequest: null } }
      );
    }

  } catch (error) {
    console.error('❌ Error cleaning up expired requests:', error);
  }
}

/**
 * Clean up expired manual booking ride requests
 * This runs every 5 seconds to check for expired pending manual bookings
 */
async function cleanupExpiredManualBookings() {
  try {
    // Find expired pending manual booking rides
    const expiredRides = await RideRequest.find({
      status: 'pending',
      bookingSource: 'manual',
      expiresAt: { $lt: new Date() },
      isManualBookingExpired: { $ne: true }
    });

    if (expiredRides.length === 0) {
      return;
    }

    console.log(`\n🕐 Found ${expiredRides.length} expired manual booking(s)`);

    for (const ride of expiredRides) {
      try {
        // Update ride status to expired
        ride.status = 'expired';
        ride.isManualBookingExpired = true;
        ride.expiredAt = new Date();
        await ride.save();

        console.log(`   ✅ Marked ride ${ride.bookingId} as expired`);

        // Notify admin room
        if (io) {
          io.to('adminRoom').emit('manualBookingExpired', {
            rideId: ride._id,
            bookingId: ride.bookingId,
            targetDriverId: ride.targetDriverId,
            targetDriverName: ride.targetDriverName || 'Unknown',
            userName: ride.userName,
            userPhone: ride.userPhone,
            pickupLocation: ride.pickupLocation?.boothName,
            dropLocation: ride.dropLocation?.address,
            vehicleType: ride.vehicleType,
            estimatedFare: ride.estimatedFare,
            expiresAt: ride.expiresAt,
            expiredAt: ride.expiredAt,
            message: `Request to ${ride.targetDriverName || 'driver'} expired (no response in 30 seconds)`,
            timestamp: new Date().toISOString()
          });
        }

        // Notify the target driver that the request expired
        if (io && ride.targetDriverId) {
          io.to(`driver_${ride.targetDriverId}`).emit('rideRequestExpired', {
            rideId: ride._id,
            bookingId: ride.bookingId,
            message: 'This ride request has expired',
            timestamp: new Date().toISOString()
          });
        }

        // Log the event
        console.log(`   📢 Notified admin and driver about expired booking ${ride.bookingId}`);

      } catch (rideError) {
        console.error(`   ❌ Error expiring ride ${ride._id}:`, rideError.message);
      }
    }

  } catch (error) {
    console.error('❌ Error cleaning up expired manual bookings:', error);
  }
}

/**
 * Get statistics about disconnected drivers
 * @returns {Object} Statistics
 */
async function getDisconnectionStats() {
  try {
    const threshold = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000);

    const disconnectedCount = await Driver.countDocuments({
      inQueue: true,
      connectionStatus: 'disconnected'
    });

    const atRiskCount = await Driver.countDocuments({
      inQueue: true,
      connectionStatus: 'disconnected',
      currentRide: null,
      lastActiveTime: { $lt: threshold }
    });

    const activeRideDisconnected = await Driver.countDocuments({
      connectionStatus: 'disconnected',
      currentRide: { $ne: null }
    });

    return {
      disconnectedCount,
      atRiskCount,
      activeRideDisconnected,
      timeoutMinutes: TIMEOUT_MINUTES,
      checkIntervalSeconds: CHECK_INTERVAL_MS / 1000
    };

  } catch (error) {
    console.error('❌ Error getting disconnection stats:', error);
    return {
      error: error.message
    };
  }
}

/**
 * Manually trigger a disconnection check (for admin use)
 * @returns {Object} Result of the check
 */
async function triggerManualCheck() {
  console.log('\n🔧 Manual disconnection check triggered');
  await checkDisconnectedDrivers();
  return await getDisconnectionStats();
}

// Interval references for cleanup
let checkInterval = null;
let manualBookingCheckInterval = null;

/**
 * Start the disconnection monitor
 */
function start() {
  if (checkInterval) {
    console.log('⚠️ Disconnection monitor is already running');
    return;
  }

  console.log('🚀 Starting disconnection monitor');
  console.log(`   - Timeout: ${TIMEOUT_MINUTES} minutes`);
  console.log(`   - Check interval: ${CHECK_INTERVAL_MS / 1000} seconds`);
  console.log(`   - Manual booking expiry check: ${MANUAL_BOOKING_CHECK_INTERVAL_MS / 1000} seconds`);

  // Run initial check
  checkDisconnectedDrivers();

  // Set up periodic check
  checkInterval = setInterval(checkDisconnectedDrivers, CHECK_INTERVAL_MS);

  // Start manual booking expiry check (every 5 seconds)
  manualBookingCheckInterval = setInterval(cleanupExpiredManualBookings, MANUAL_BOOKING_CHECK_INTERVAL_MS);

  console.log('✅ Disconnection monitor started');
}

/**
 * Stop the disconnection monitor
 */
function stop() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  if (manualBookingCheckInterval) {
    clearInterval(manualBookingCheckInterval);
    manualBookingCheckInterval = null;
  }
  console.log('🛑 Disconnection monitor stopped');
}

module.exports = {
  start,
  stop,
  setIO,
  getIO,
  checkDisconnectedDrivers,
  cleanupExpiredManualBookings,
  getDisconnectionStats,
  triggerManualCheck,
  TIMEOUT_MINUTES,
  CHECK_INTERVAL_MS,
  MANUAL_BOOKING_CHECK_INTERVAL_MS
};
