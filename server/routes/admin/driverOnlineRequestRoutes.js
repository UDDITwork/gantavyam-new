/**
 * Admin Routes for Driver Online Requests
 * Allows admins with queue:manage permission to approve/reject driver online requests
 */
const express = require('express');
const router = express.Router();
const { adminProtect } = require('../../middleware/auth');
const { checkPermission, PERMISSIONS } = require('../../middleware/permissions');
const DriverOnlineRequest = require('../../models/DriverOnlineRequest');
const Driver = require('../../models/Driver');
const { getIO } = require('../../socket');
const { acquireLock, releaseLock } = require('../../utils/lockManager');

// Middleware to ensure only admins can access these routes
router.use(adminProtect);

/**
 * GET /api/admin/online-requests
 * Get all pending driver online requests
 * Permission: queue:view (all admins can view)
 */
router.get('/', async (req, res) => {
  try {
    console.log('\n=== ADMIN: GET PENDING ONLINE REQUESTS ===');
    console.log('Admin:', req.admin.fullName);

    const { status = 'pending', limit = 50 } = req.query;

    const query = {};
    if (status !== 'all') {
      query.status = status;
    }

    const requests = await DriverOnlineRequest.find(query)
      .sort({ requestedAt: 1 }) // Oldest first (FIFO)
      .limit(parseInt(limit))
      .lean();

    // Add time remaining for pending requests
    const enrichedRequests = requests.map(request => ({
      ...request,
      timeRemaining: request.status === 'pending'
        ? Math.max(0, Math.floor((new Date(request.expiresAt) - Date.now()) / 1000))
        : null
    }));

    console.log(`📋 Found ${requests.length} ${status} requests`);

    res.json({
      success: true,
      requests: enrichedRequests,
      count: enrichedRequests.length
    });

  } catch (error) {
    console.error('❌ Error fetching online requests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch online requests',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/online-requests/count
 * Get count of pending requests (for bell icon badge)
 * Permission: queue:view
 */
router.get('/count', async (req, res) => {
  try {
    const pendingCount = await DriverOnlineRequest.getPendingCount();

    res.json({
      success: true,
      pendingCount
    });

  } catch (error) {
    console.error('❌ Error fetching pending count:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending count',
      error: error.message
    });
  }
});

/**
 * GET /api/admin/online-requests/by-booth/:boothName
 * Get pending requests for a specific booth
 * Permission: queue:view
 */
router.get('/by-booth/:boothName', async (req, res) => {
  try {
    const { boothName } = req.params;
    console.log(`\n=== ADMIN: GET REQUESTS FOR BOOTH - ${boothName} ===`);

    const requests = await DriverOnlineRequest.getPendingByBooth(boothName);

    res.json({
      success: true,
      requests,
      count: requests.length
    });

  } catch (error) {
    console.error('❌ Error fetching booth requests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch booth requests',
      error: error.message
    });
  }
});

/**
 * POST /api/admin/online-requests/:id/approve
 * Approve a driver's online request
 * Permission: queue:manage
 */
router.post('/:id/approve', checkPermission(PERMISSIONS.QUEUE_MANAGE), async (req, res) => {
  const { id } = req.params;
  const lockKey = `approve_online_${id}`;
  let lockAcquired = false;

  try {
    console.log('\n=== ADMIN: APPROVE ONLINE REQUEST ===');
    console.log('Admin:', req.admin.fullName);
    console.log('Request ID:', id);

    // Acquire lock to prevent race conditions
    lockAcquired = acquireLock(lockKey, 10000);
    if (!lockAcquired) {
      return res.status(409).json({
        success: false,
        message: 'Request is being processed by another admin'
      });
    }

    // Find the request
    const request = await DriverOnlineRequest.findById(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    // Idempotency check - if already approved, return success
    if (request.status === 'approved') {
      console.log('✅ Request already approved (idempotent response)');
      return res.json({
        success: true,
        alreadyApproved: true,
        message: 'Request was already approved',
        request
      });
    }

    // Check if request is still pending
    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot approve. Request status is: ${request.status}`
      });
    }

    // Check if request has expired
    if (new Date() > request.expiresAt) {
      request.status = 'expired';
      await request.save();
      return res.status(400).json({
        success: false,
        message: 'Request has expired'
      });
    }

    // Approve the request
    await request.approve(req.admin._id, req.admin.fullName);

    // Update driver status - add to queue
    const driver = await Driver.findById(request.driverId);
    if (driver) {
      driver.isOnline = true;
      driver.inQueue = true;
      driver.connectionStatus = 'disconnected'; // Will be updated when socket connects
      driver.currentMetroBooth = request.boothName;
      driver.queueEntryTime = new Date();
      driver.pendingOnlineRequest = null;

      // Set location from request
      if (request.location && request.location.coordinates) {
        driver.location = {
          type: 'Point',
          coordinates: request.location.coordinates,
          lastUpdated: new Date()
        };
      }

      await driver.save();

      console.log('✅ Driver approved and added to queue');
      console.log('Driver:', driver.fullName);
      console.log('Booth:', request.boothName);
    }

    // Notify driver via socket
    try {
      const io = getIO();

      // Notify the driver
      io.to(`driver_${request.driverId}`).emit('onlineRequestApproved', {
        requestId: request._id,
        approvedBy: req.admin.fullName,
        boothName: request.boothName,
        message: 'Your online request has been approved!'
      });

      // Notify other admins
      io.to('admins').emit('onlineRequestProcessed', {
        requestId: request._id,
        driverName: request.driverName,
        status: 'approved',
        processedBy: req.admin.fullName
      });
    } catch (socketError) {
      console.error('Socket notification failed:', socketError);
      // Continue - approval is successful even if notification fails
    }

    res.json({
      success: true,
      message: `${request.driverName} has been approved to go online`,
      request: {
        _id: request._id,
        driverId: request.driverId,
        driverName: request.driverName,
        boothName: request.boothName,
        status: 'approved',
        processedAt: request.processedAt,
        processedBy: req.admin.fullName
      }
    });

  } catch (error) {
    console.error('❌ Error approving request:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to approve request',
      error: error.message
    });
  } finally {
    if (lockAcquired) {
      releaseLock(lockKey);
    }
  }
});

/**
 * POST /api/admin/online-requests/:id/reject
 * Reject a driver's online request
 * Permission: queue:manage
 */
router.post('/:id/reject', checkPermission(PERMISSIONS.QUEUE_MANAGE), async (req, res) => {
  const { id } = req.params;
  const { reason = '' } = req.body;
  const lockKey = `reject_online_${id}`;
  let lockAcquired = false;

  try {
    console.log('\n=== ADMIN: REJECT ONLINE REQUEST ===');
    console.log('Admin:', req.admin.fullName);
    console.log('Request ID:', id);
    console.log('Reason:', reason || '(no reason provided)');

    // Acquire lock to prevent race conditions
    lockAcquired = acquireLock(lockKey, 10000);
    if (!lockAcquired) {
      return res.status(409).json({
        success: false,
        message: 'Request is being processed by another admin'
      });
    }

    // Find the request
    const request = await DriverOnlineRequest.findById(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Request not found'
      });
    }

    // Idempotency check - if already rejected, return success
    if (request.status === 'rejected') {
      console.log('✅ Request already rejected (idempotent response)');
      return res.json({
        success: true,
        alreadyRejected: true,
        message: 'Request was already rejected',
        request
      });
    }

    // Check if request is still pending
    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot reject. Request status is: ${request.status}`
      });
    }

    // Reject the request
    await request.reject(req.admin._id, req.admin.fullName, reason);

    // Update driver's pending request reference
    await Driver.findByIdAndUpdate(request.driverId, {
      pendingOnlineRequest: null
    });

    console.log('✅ Request rejected');

    // Notify driver via socket
    try {
      const io = getIO();

      io.to(`driver_${request.driverId}`).emit('onlineRequestRejected', {
        requestId: request._id,
        rejectedBy: req.admin.fullName,
        reason: reason || 'No reason provided',
        message: 'Your online request has been rejected. You can submit a new request.'
      });

      io.to('admins').emit('onlineRequestProcessed', {
        requestId: request._id,
        driverName: request.driverName,
        status: 'rejected',
        processedBy: req.admin.fullName
      });
    } catch (socketError) {
      console.error('Socket notification failed:', socketError);
    }

    res.json({
      success: true,
      message: `${request.driverName}'s request has been rejected`,
      request: {
        _id: request._id,
        driverId: request.driverId,
        driverName: request.driverName,
        status: 'rejected',
        rejectionReason: reason,
        processedAt: request.processedAt,
        processedBy: req.admin.fullName
      }
    });

  } catch (error) {
    console.error('❌ Error rejecting request:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reject request',
      error: error.message
    });
  } finally {
    if (lockAcquired) {
      releaseLock(lockKey);
    }
  }
});

/**
 * POST /api/admin/online-requests/bulk-approve
 * Approve multiple requests at once
 * Permission: queue:manage
 */
router.post('/bulk-approve', checkPermission(PERMISSIONS.QUEUE_MANAGE), async (req, res) => {
  try {
    const { requestIds } = req.body;
    console.log('\n=== ADMIN: BULK APPROVE REQUESTS ===');
    console.log('Admin:', req.admin.fullName);
    console.log('Request IDs:', requestIds);

    if (!Array.isArray(requestIds) || requestIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Request IDs array is required'
      });
    }

    const results = {
      approved: [],
      failed: []
    };

    for (const requestId of requestIds) {
      try {
        const request = await DriverOnlineRequest.findById(requestId);

        if (!request || request.status !== 'pending') {
          results.failed.push({
            requestId,
            reason: !request ? 'Not found' : `Status is ${request.status}`
          });
          continue;
        }

        // Check expiry
        if (new Date() > request.expiresAt) {
          request.status = 'expired';
          await request.save();
          results.failed.push({ requestId, reason: 'Expired' });
          continue;
        }

        // Approve
        await request.approve(req.admin._id, req.admin.fullName);

        // Update driver
        const driver = await Driver.findById(request.driverId);
        if (driver) {
          driver.isOnline = true;
          driver.inQueue = true;
          driver.connectionStatus = 'disconnected';
          driver.currentMetroBooth = request.boothName;
          driver.queueEntryTime = new Date();
          driver.pendingOnlineRequest = null;
          await driver.save();
        }

        results.approved.push({
          requestId,
          driverName: request.driverName
        });

        // Notify driver
        const io = getIO();
        io.to(`driver_${request.driverId}`).emit('onlineRequestApproved', {
          requestId: request._id,
          approvedBy: req.admin.fullName,
          boothName: request.boothName
        });

      } catch (err) {
        results.failed.push({ requestId, reason: err.message });
      }
    }

    console.log(`✅ Bulk approval complete: ${results.approved.length} approved, ${results.failed.length} failed`);

    res.json({
      success: true,
      message: `Approved ${results.approved.length} requests`,
      results
    });

  } catch (error) {
    console.error('❌ Error in bulk approve:', error);
    res.status(500).json({
      success: false,
      message: 'Bulk approve failed',
      error: error.message
    });
  }
});

module.exports = router;
