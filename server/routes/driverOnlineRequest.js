/**
 * Driver Routes for Online Request System
 * Allows drivers to request going online, check status, and cancel requests
 */
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const DriverOnlineRequest = require('../models/DriverOnlineRequest');
const Driver = require('../models/Driver');
const { getIO } = require('../socket');
const { toAdminsAndExecutives } = require('../utils/adminRealtime');

/**
 * POST /api/drivers/online-request
 * Submit a request to go online
 */
router.post('/online-request', protect, async (req, res) => {
  try {
    const driverId = req.user.id;
    const { boothName, location } = req.body;

    console.log('\n=== DRIVER: REQUEST TO GO ONLINE ===');
    console.log('Driver ID:', driverId);
    console.log('Booth:', boothName);

    // Validate input
    if (!boothName) {
      return res.status(400).json({
        success: false,
        message: 'Booth name is required'
      });
    }

    // Get driver details
    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    // Check if driver is already online
    if (driver.isOnline && driver.inQueue) {
      return res.json({
        success: true,
        alreadyOnline: true,
        message: 'You are already online',
        status: 'approved'
      });
    }

    // Check if driver already has a pending request
    const existingRequest = await DriverOnlineRequest.findOne({
      driverId,
      status: 'pending'
    });

    if (existingRequest) {
      console.log('✅ Returning existing pending request');
      return res.json({
        success: true,
        pendingRequest: true,
        message: 'You already have a pending request',
        request: {
          _id: existingRequest._id,
          status: 'pending',
          boothName: existingRequest.boothName,
          requestedAt: existingRequest.requestedAt,
          expiresAt: existingRequest.expiresAt,
          timeRemaining: Math.max(0, Math.floor((existingRequest.expiresAt - Date.now()) / 1000))
        }
      });
    }

    // Create new request
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    const newRequest = await DriverOnlineRequest.create({
      driverId: driver._id,
      driverName: driver.fullName,
      driverPhone: driver.mobileNo,
      driverPhoto: driver.driverSelfie,
      boothName,
      vehicleType: driver.vehicleType,
      location: location ? {
        type: 'Point',
        coordinates: [location.lng || 0, location.lat || 0]
      } : undefined,
      expiresAt
    });

    // Update driver with pending request reference
    driver.pendingOnlineRequest = newRequest._id;
    await driver.save();

    console.log('✅ Online request created');
    console.log('Request ID:', newRequest._id);
    console.log('Expires at:', expiresAt);

    // Notify admins via socket
    try {
      const io = getIO();
      toAdminsAndExecutives(io, 'admins').emit('newOnlineRequest', {
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
        message: `${driver.fullName} wants to go online at ${boothName}`
      });
    } catch (socketError) {
      console.error('Socket notification failed:', socketError);
    }

    res.json({
      success: true,
      message: 'Online request submitted. Waiting for admin approval.',
      request: {
        _id: newRequest._id,
        status: 'pending',
        boothName: newRequest.boothName,
        requestedAt: newRequest.requestedAt,
        expiresAt: newRequest.expiresAt,
        timeRemaining: 600 // 10 minutes in seconds
      }
    });

  } catch (error) {
    console.error('❌ Error creating online request:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create online request',
      error: error.message
    });
  }
});

/**
 * GET /api/drivers/online-request/status
 * Check the status of driver's online request (for polling)
 */
router.get('/online-request/status', protect, async (req, res) => {
  try {
    const driverId = req.user.id;

    console.log('\n=== DRIVER: CHECK ONLINE REQUEST STATUS ===');
    console.log('Driver ID:', driverId);

    // Get driver
    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    // If driver is already online, return that status
    if (driver.isOnline && driver.inQueue) {
      return res.json({
        success: true,
        status: 'approved',
        isOnline: true,
        message: 'You are online',
        boothName: driver.currentMetroBooth
      });
    }

    // Check for any pending request
    const pendingRequest = await DriverOnlineRequest.findOne({
      driverId,
      status: 'pending'
    });

    if (pendingRequest) {
      // Check if expired
      if (new Date() > pendingRequest.expiresAt) {
        pendingRequest.status = 'expired';
        await pendingRequest.save();

        // Clear driver's pending request reference
        driver.pendingOnlineRequest = null;
        await driver.save();

        return res.json({
          success: true,
          status: 'expired',
          message: 'Your request has expired. Please submit a new request.',
          canRetry: true
        });
      }

      return res.json({
        success: true,
        status: 'pending',
        message: 'Waiting for admin approval',
        request: {
          _id: pendingRequest._id,
          boothName: pendingRequest.boothName,
          requestedAt: pendingRequest.requestedAt,
          expiresAt: pendingRequest.expiresAt,
          timeRemaining: Math.max(0, Math.floor((pendingRequest.expiresAt - Date.now()) / 1000))
        }
      });
    }

    // Check for recently processed request
    const recentRequest = await DriverOnlineRequest.findOne({
      driverId,
      status: { $in: ['approved', 'rejected', 'expired'] }
    }).sort({ processedAt: -1 });

    if (recentRequest) {
      if (recentRequest.status === 'approved') {
        // Driver was approved but might have been disconnected
        // Check if they should be online
        if (!driver.isOnline) {
          driver.isOnline = true;
          driver.inQueue = true;
          driver.currentMetroBooth = recentRequest.boothName;
          await driver.save();
        }

        return res.json({
          success: true,
          status: 'approved',
          isOnline: true,
          message: 'Your request was approved! You are now online.',
          boothName: recentRequest.boothName,
          approvedBy: recentRequest.processedByName
        });
      }

      if (recentRequest.status === 'rejected') {
        return res.json({
          success: true,
          status: 'rejected',
          message: recentRequest.rejectionReason || 'Your request was rejected',
          rejectedBy: recentRequest.processedByName,
          canRetry: true
        });
      }
    }

    // No request found
    return res.json({
      success: true,
      status: 'none',
      isOnline: false,
      message: 'No pending request. You can submit a new request to go online.',
      canRetry: true
    });

  } catch (error) {
    console.error('❌ Error checking request status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check request status',
      error: error.message
    });
  }
});

/**
 * DELETE /api/drivers/online-request
 * Cancel a pending online request
 */
router.delete('/online-request', protect, async (req, res) => {
  try {
    const driverId = req.user.id;

    console.log('\n=== DRIVER: CANCEL ONLINE REQUEST ===');
    console.log('Driver ID:', driverId);

    // Find pending request
    const pendingRequest = await DriverOnlineRequest.findOne({
      driverId,
      status: 'pending'
    });

    if (!pendingRequest) {
      return res.status(404).json({
        success: false,
        message: 'No pending request to cancel'
      });
    }

    // Cancel the request
    await pendingRequest.cancel();

    // Update driver
    await Driver.findByIdAndUpdate(driverId, {
      pendingOnlineRequest: null
    });

    console.log('✅ Request cancelled');

    // Notify admins
    try {
      const io = getIO();
      toAdminsAndExecutives(io, 'admins').emit('onlineRequestCancelled', {
        requestId: pendingRequest._id,
        driverName: pendingRequest.driverName,
        boothName: pendingRequest.boothName
      });
    } catch (socketError) {
      console.error('Socket notification failed:', socketError);
    }

    res.json({
      success: true,
      message: 'Online request cancelled'
    });

  } catch (error) {
    console.error('❌ Error cancelling request:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel request',
      error: error.message
    });
  }
});

/**
 * POST /api/drivers/go-offline
 * Driver goes offline (REST API alternative to socket)
 */
router.post('/go-offline', protect, async (req, res) => {
  try {
    const driverId = req.user.id;

    console.log('\n=== DRIVER: GO OFFLINE (REST API) ===');
    console.log('Driver ID:', driverId);

    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    // Check if driver has active ride
    if (driver.currentRide) {
      return res.status(400).json({
        success: false,
        message: 'Cannot go offline while you have an active ride'
      });
    }

    // Update driver status
    driver.isOnline = false;
    driver.inQueue = false;
    driver.connectionStatus = 'offline';
    driver.queuePosition = null;
    driver.queueEntryTime = null;
    driver.currentMetroBooth = null;
    await driver.save();

    console.log('✅ Driver went offline');

    // Notify admins
    try {
      const io = getIO();
      toAdminsAndExecutives(io, 'admins').emit('driverWentOffline', {
        driverId: driver._id,
        driverName: driver.fullName
      });
    } catch (socketError) {
      console.error('Socket notification failed:', socketError);
    }

    res.json({
      success: true,
      message: 'You are now offline'
    });

  } catch (error) {
    console.error('❌ Error going offline:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to go offline',
      error: error.message
    });
  }
});

/**
 * POST /api/drivers/push-subscription
 * Save driver's push notification subscription
 */
router.post('/push-subscription', protect, async (req, res) => {
  try {
    const driverId = req.user.id;
    const { subscription } = req.body;

    console.log('\n=== DRIVER: SAVE PUSH SUBSCRIPTION ===');
    console.log('Driver ID:', driverId);

    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({
        success: false,
        message: 'Valid push subscription is required'
      });
    }

    await Driver.findByIdAndUpdate(driverId, {
      pushSubscription: {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys?.p256dh,
          auth: subscription.keys?.auth
        },
        subscribedAt: new Date()
      }
    });

    console.log('✅ Push subscription saved');

    res.json({
      success: true,
      message: 'Push subscription saved'
    });

  } catch (error) {
    console.error('❌ Error saving push subscription:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save push subscription',
      error: error.message
    });
  }
});

/**
 * DELETE /api/drivers/push-subscription
 * Remove driver's push notification subscription
 */
router.delete('/push-subscription', protect, async (req, res) => {
  try {
    const driverId = req.user.id;

    console.log('\n=== DRIVER: REMOVE PUSH SUBSCRIPTION ===');
    console.log('Driver ID:', driverId);

    await Driver.findByIdAndUpdate(driverId, {
      $unset: { pushSubscription: 1 }
    });

    console.log('✅ Push subscription removed');

    res.json({
      success: true,
      message: 'Push subscription removed'
    });

  } catch (error) {
    console.error('❌ Error removing push subscription:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove push subscription',
      error: error.message
    });
  }
});

module.exports = router;
