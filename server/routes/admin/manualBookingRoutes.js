const express = require('express');
const router = express.Router();
const RideRequest = require('../../models/RideRequest');
const User = require('../../models/User');
const Driver = require('../../models/Driver');
const BoothQueue = require('../../models/BoothQueue');
const PickupLocation = require('../../models/PickupLocation');
const { adminProtect } = require('../../middleware/auth');
const { checkPermission, PERMISSIONS } = require('../../middleware/permissions');
const { generateOTP } = require('../../utils/otpUtils');
const twilioSmsService = require('../../services/twilioSmsService');
const { getIO, sendRideRequestToDriver } = require('../../socket');
const { v4: uuidv4 } = require('uuid');
const { logRideEvent, logDriverAction, logStatusTransition, logSocketDelivery, logError } = require('../../utils/rideLogger');
const { calculateFare } = require('../../utils/fareCalculator');
const { isExecutive, podOf, canAccessDoc, boothCondition, forbidden } = require('../../utils/podScope');
const { toAdmins } = require('../../utils/adminRealtime');

// Executives book only at their own pickup point, whatever the request says
const pinPickupToPod = (req, res, next) => {
  if (isExecutive(req.admin)) {
    const pod = podOf(req.admin);
    if (!pod) return forbidden(res, 'Your account is not linked to a pickup point yet.');
    req.body = req.body || {};
    req.body.pickupStation = pod.name;
    req.body.pickupLocation = pod.name;
  }
  next();
};

// Manual booking endpoint (requires manual booking permission)
router.post('/manual-booking', adminProtect, checkPermission(PERMISSIONS.RIDES_MANUAL_BOOKING), pinPickupToPod, async (req, res) => {
  try {
    const {
      pickupStation,
      pickupLocation,
      dropLocation,
      vehicleType,
      estimatedFare,
      distance,
      userPhone,
      userName,
      existingUserId,
      selectedDriverId, // Add support for manual driver selection
      bookingSource,
      paymentStatus,
      paymentMethod,
      fareBreakdown // Frontend sends fare breakdown to avoid recalculation mismatch
    } = req.body;

    // Validate phone number
    if (!userPhone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    // Check if phone number is valid (10 digits starting with 6-9)
    const phoneRegex = /^[6-9]\d{9}$/;
    if (!phoneRegex.test(userPhone)) {
      console.error(`❌ Invalid phone number format: ${userPhone}`);
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Must be 10 digits starting with 6-9'
      });
    }

    console.log(`✅ Valid phone number received: ${userPhone}`);

    // Find or create user
    let user;
    if (existingUserId) {
      user = await User.findById(existingUserId);
    } else {
      // Check if user with phone exists
      user = await User.findOne({ phone: userPhone });
      
      if (!user) {
        // Create new user
        user = new User({
          name: userName,
          phone: userPhone,
          password: userPhone, // Default password is phone number
          role: 'user',
          isPhoneVerified: true,
          createdBy: 'admin'
        });
        await user.save();
      }
    }

    // Find pickup location by name to get ObjectId
    const pickupLocationDoc = await PickupLocation.findOne({ 
      name: pickupStation,
      isActive: true 
    });

    if (!pickupLocationDoc) {
      return res.status(400).json({
        success: false,
        message: `Pickup location '${pickupStation}' not found or inactive`
      });
    }

    // Generate both OTPs upfront
    const startOTP = generateOTP();
    const endOTP = generateOTP();
    const bookingId = `MNL${Date.now()}${Math.floor(Math.random() * 100)}`;

    // Get queue number for the booth
    const queueEntry = await BoothQueue.findOneAndUpdate(
      { boothName: pickupStation },
      { $inc: { currentNumber: 1 } },
      { new: true, upsert: true }
    );

    const queueNumber = queueEntry.currentNumber;

    // Use frontend fare values if provided (to match what admin saw in UI)
    // Otherwise recalculate as fallback for backward compatibility
    let fareDetails;
    if (fareBreakdown && fareBreakdown.customerTotalFare) {
      // Use frontend values - this ensures UI fare matches database
      fareDetails = {
        customerTotalFare: fareBreakdown.customerTotalFare,
        driverFare: fareBreakdown.driverFare,
        platformEarning: fareBreakdown.platformEarning || (fareBreakdown.customerTotalFare - fareBreakdown.driverFare),
        baseFare: 0,
        gstAmount: 0,
        commissionAmount: 0,
        nightChargeAmount: fareBreakdown.nightChargeUserAmount || 0,
        nightChargeUserAmount: fareBreakdown.nightChargeUserAmount || 0,
        nightChargeDriverAmount: fareBreakdown.nightChargeDriverAmount || 0,
        isNightCharge: fareBreakdown.isNightCharge || false,
        breakdown: fareBreakdown
      };
      console.log('📋 Using frontend fare values:', fareDetails.customerTotalFare);
    } else {
      // Fallback: recalculate (for backward compatibility)
      fareDetails = await calculateFare(vehicleType, distance, true, 0);
      console.log('📋 Recalculated fare:', fareDetails.customerTotalFare);
    }

    // Create the ride request with both driver and customer fares
    const rideRequest = new RideRequest({
      userId: user._id,
      user: user._id,
      userName: user.name,
      userPhone: user.phone,
      pickupStation: pickupLocationDoc._id,
      pickupLocation: {
        boothName: pickupLocationDoc.name,
        latitude: pickupLocationDoc.lat || 0,
        longitude: pickupLocationDoc.lng || 0
      },
      dropLocation: {
        address: dropLocation,
        latitude: 0, // These can be populated from geocoding if needed
        longitude: 0
      },
      vehicleType,
      estimatedFare: fareDetails.customerTotalFare, // What customer sees and pays
      fare: fareDetails.driverFare, // Driver earnings
      driverFare: fareDetails.driverFare, // Explicit driver earnings
      customerFare: fareDetails.customerTotalFare, // What customer pays
      platformEarning: fareDetails.platformEarning,
      baseFare: 0,
      gstAmount: 0,    // No GST in new formula
      commissionAmount: 0, // No commission in new formula
      nightChargeAmount: fareDetails.nightChargeUserAmount || fareDetails.nightChargeAmount || 0,
      fareBreakdown: fareDetails.breakdown,
      distance,
      startOTP,
      endOTP,
      rideId: bookingId,
      bookingId,
      queueNumber,
      bookingSource: 'manual',
      paymentStatus: paymentStatus || 'collected',
      paymentMethod: paymentMethod,
      paymentCollectedAt: paymentStatus === 'collected' ? new Date() : null,
      status: 'pending',
      adminId: req.admin._id,
      adminName: req.admin.name,
      // Manual booking expiry - 60 seconds (1 minute)
      expiresAt: new Date(Date.now() + 60 * 1000),
      isManualBookingExpired: false
    });

    // Save the ride request first
    await rideRequest.save();

    // Debug: Log payment details
    console.log('📋 Manual Booking Payment Details:', {
      bookingId: rideRequest.bookingId,
      paymentStatus: rideRequest.paymentStatus,
      paymentMethod: rideRequest.paymentMethod,
      savedToDB: true
    });

    // Log ride creation
    logRideEvent(rideRequest._id, 'manual_booking_created', {
      bookingId: rideRequest.bookingId,
      adminId: req.admin._id,
      adminName: req.admin.name,
      pickupStation,
      dropLocation,
      vehicleType,
      estimatedFare,
      userPhone,
      userName,
      paymentMethod: rideRequest.paymentMethod,
      paymentStatus: rideRequest.paymentStatus
    });

    // Find driver to send request to
    let targetDriver = null;
    
    if (selectedDriverId) {
      // Manual driver selection - validate the selected driver
      console.log(`\n🎯 MANUAL DRIVER SELECTION DEBUGGING`);
      console.log(`   Selected Driver ID: ${selectedDriverId}`);
      console.log(`   Pickup Station: ${pickupStation}`);
      console.log(`   Vehicle Type: ${vehicleType}`);
      
      // First check if driver exists at all
      const driverExists = await Driver.findById(selectedDriverId);
      if (!driverExists) {
        console.log(`❌ Driver with ID ${selectedDriverId} not found in database`);
        return res.status(400).json({
          success: false,
          message: 'Selected driver not found in database'
        });
      }
      
      console.log(`✅ Driver found in database: ${driverExists.fullName}`);
      console.log(`   Current Status:`, {
        isOnline: driverExists.isOnline,
        currentMetroBooth: driverExists.currentMetroBooth,
        currentRide: driverExists.currentRide,
        vehicleType: driverExists.vehicleType,
        queuePosition: driverExists.queuePosition
      });
      
      // For admin manual selection - relaxed validation
      // Admin explicitly chose this driver, so we only check critical requirements:
      // 1. Driver must not have an active ride (currentRide: null)
      // 2. Vehicle type must match
      // We SKIP: isOnline, currentMetroBooth and connectionStatus checks (admin override)
      // Admin can send requests to offline drivers - they will receive notification when back online
      targetDriver = await Driver.findOne({
        _id: selectedDriverId,
        currentRide: null,
        vehicleType: vehicleType
      });

      if (targetDriver) {
        // Log warnings for non-blocking issues
        if (!targetDriver.isOnline) {
          console.log(`⚠️ Warning: Driver is OFFLINE - request will be waiting for driver to come online`);
        }
        if (targetDriver.connectionStatus !== 'connected') {
          console.log(`⚠️ Warning: Driver socket not connected (status: ${targetDriver.connectionStatus}) - proceeding anyway for manual booking`);
        }

        // Update driver's booth to match pickup station if different
        if (targetDriver.currentMetroBooth !== pickupStation) {
          console.log(`📍 Updating driver booth from "${targetDriver.currentMetroBooth}" to "${pickupStation}"`);
          await Driver.findByIdAndUpdate(
            targetDriver._id,
            { currentMetroBooth: pickupStation },
            { runValidators: false }
          );
          targetDriver.currentMetroBooth = pickupStation; // Update local reference
        }

        console.log(`✅ Driver passes validation checks: ${targetDriver.fullName} (Queue #${targetDriver.queuePosition})`);
      } else {
        console.log(`❌ Driver ${driverExists.fullName} failed validation checks`);

        // Determine specific reason for failure (only critical issues)
        const reasons = [];
        // Removed: isOnline check - admin can send to offline drivers
        if (driverExists.currentRide) reasons.push('Driver has active ride');
        if (driverExists.vehicleType !== vehicleType) reasons.push(`Vehicle type mismatch (${driverExists.vehicleType} vs ${vehicleType})`);

        return res.status(400).json({
          success: false,
          message: `Selected driver is not available: ${reasons.join(', ')}`
        });
      }
    } else {
      // Auto-selection - find driver from queue position 1
      console.log(`🔍 Auto-selection: Looking for available driver at ${pickupStation} with queue position 1`);
      
      // First, check all drivers at this station for debugging
      const allDriversAtStation = await Driver.find({
        currentMetroBooth: pickupStation,
        isOnline: true
      }).select('fullName queuePosition currentRide isOnline vehicleType currentMetroBooth');
      
      // Also get all online drivers regardless of booth for debugging
      const allOnlineDrivers = await Driver.find({
        isOnline: true,
        vehicleType: vehicleType
      }).select('fullName queuePosition currentRide isOnline vehicleType currentMetroBooth');
      
      console.log(`📊 All online drivers at ${pickupStation}:`, allDriversAtStation.map(d => ({
        name: d.fullName,
        queuePosition: d.queuePosition,
        currentRide: d.currentRide,
        isOnline: d.isOnline,
        vehicleType: d.vehicleType,
        currentMetroBooth: d.currentMetroBooth
      })));
      
      console.log(`🌐 All online ${vehicleType} drivers (any location):`, allOnlineDrivers.map(d => ({
        name: d.fullName,
        queuePosition: d.queuePosition,
        currentMetroBooth: d.currentMetroBooth || 'NOT SET',
        hasActiveRide: !!d.currentRide
      })));
      
      // Also check drivers that might be connected via socket but DB not updated yet
      const io = getIO();
      if (io && allDriversAtStation.length === 0) {
        console.log(`🔌 No drivers found in DB, checking socket connections...`);
        const allSockets = io.sockets.sockets;
        for (const [socketId, socket] of allSockets) {
          if (socket.user && socket.user.role === 'driver' && 
              socket.user.currentMetroBooth === pickupStation &&
              socket.user.vehicleType === vehicleType) {
            console.log(`🔌 Found connected driver via socket: ${socket.user.fullName} (${socket.user._id})`);
            // Try to find this driver in DB and update their status
            const connectedDriver = await Driver.findById(socket.user._id);
            if (connectedDriver && !connectedDriver.isOnline) {
              console.log(`📝 Updating socket-connected driver ${socket.user._id} to online in DB`);
              await Driver.findByIdAndUpdate(socket.user._id, {
                isOnline: true,
                currentMetroBooth: pickupStation,
                vehicleType: vehicleType,
                lastActiveTime: new Date()
              });
            }
          }
        }
      }
      
      // First try to find first CONNECTED driver by queue position (not just position 1)
      targetDriver = await Driver.findOne({
        currentMetroBooth: pickupStation,
        isOnline: true,
        connectionStatus: 'connected', // Must have active socket connection
        currentRide: null,
        vehicleType: vehicleType // Ensure vehicle type matches
      }).sort({ queuePosition: 1 }); // Get driver with lowest queue position
      
      // If no exact match, try without booth restriction (for drivers who haven't set location)
      if (!targetDriver) {
        console.log(`🔄 No connected driver found at booth, trying without booth restriction...`);
        console.log(`🔍 Looking for: vehicleType=${vehicleType}, connectionStatus=connected, isOnline=true, currentRide=null`);

        targetDriver = await Driver.findOne({
          isOnline: true,
          connectionStatus: 'connected', // Must have active socket connection
          currentRide: null,
          vehicleType: vehicleType
        }).sort({ queuePosition: 1 }); // Get driver with lowest queue position
        
        if (targetDriver) {
          console.log(`✅ Found driver without booth restriction: ${targetDriver.fullName}`);
          console.log(`   Current booth: ${targetDriver.currentMetroBooth || 'NOT SET'}`);
          console.log(`   Updating to: ${pickupStation}`);
          // Update their booth to match the booking
          targetDriver.currentMetroBooth = pickupStation;
          await targetDriver.save();
          console.log(`   ✅ Driver booth updated successfully`);
        } else {
          console.log(`❌ No driver found even without booth restriction`);
        }
      }
      
      if (targetDriver) {
        console.log(`✅ Found available connected driver: ${targetDriver.fullName} (Queue #${targetDriver.queuePosition})`);
      } else {
        console.log(`❌ No connected ${vehicleType} driver available for ${pickupStation}`);

        // Check for disconnected drivers that are in queue but not reachable
        const disconnectedDrivers = await Driver.find({
          isOnline: true,
          connectionStatus: 'disconnected',
          currentRide: null,
          vehicleType: vehicleType
        }).select('fullName queuePosition currentMetroBooth lastActiveTime');

        // Provide more detailed debugging info
        const debugInfo = {
          searchCriteria: {
            pickupStation,
            vehicleType,
            connectionStatus: 'connected',
            isOnline: true,
            currentRide: null
          },
          driversFoundAtStation: allDriversAtStation.length,
          driversAtStation: allDriversAtStation.map(d => ({
            name: d.fullName,
            queuePosition: d.queuePosition,
            vehicleType: d.vehicleType,
            isOnline: d.isOnline,
            currentMetroBooth: d.currentMetroBooth || 'NOT SET',
            hasActiveRide: !!d.currentRide
          })),
          allOnlineDriversOfType: allOnlineDrivers.map(d => ({
            name: d.fullName,
            queuePosition: d.queuePosition,
            currentMetroBooth: d.currentMetroBooth || 'NOT SET',
            hasActiveRide: !!d.currentRide
          })),
          disconnectedDriversCount: disconnectedDrivers.length,
          disconnectedDrivers: disconnectedDrivers.map(d => ({
            name: d.fullName,
            queuePosition: d.queuePosition,
            booth: d.currentMetroBooth || 'NOT SET',
            lastSeen: d.lastActiveTime
          }))
        };

        console.log('📊 Debug info for failed driver search:', debugInfo);

        const hasDisconnectedDrivers = disconnectedDrivers.length > 0;
        const errorMessage = hasDisconnectedDrivers
          ? `No connected ${vehicleType} drivers available. ${disconnectedDrivers.length} driver(s) are in queue but not reachable. Please select a specific connected driver or wait for a driver to reconnect.`
          : `No available ${vehicleType} driver. Please select a specific driver or wait for drivers to come online.`;

        return res.status(400).json({
          success: false,
          message: errorMessage,
          disconnectedDrivers: disconnectedDrivers.map(d => ({
            name: d.fullName,
            queuePosition: d.queuePosition,
            booth: d.currentMetroBooth,
            lastSeen: d.lastActiveTime
          })),
          debug: debugInfo
        });
      }
    }

    // Track if driver was notified - used for response messaging (declared outside if block for scope)
    let driverNotified = false;
    let notificationWarning = null;

    // Send ride request to target driver
    if (targetDriver) {
      // Update ride with target driver info and reset expiry timer
      rideRequest.status = 'pending';
      rideRequest.targetDriverId = targetDriver._id;
      rideRequest.targetDriverName = targetDriver.fullName;
      // Reset expiry to 60 seconds (1 minute) from now (in case there was processing time)
      rideRequest.expiresAt = new Date(Date.now() + 60 * 1000);
      await rideRequest.save();

      console.log(`\n📤 MANUAL BOOKING: Sending ride request to driver`);
      console.log(`   Driver Name: ${targetDriver.fullName}`);
      console.log(`   Driver ID: ${targetDriver._id}`);
      console.log(`   Driver ID Type: ${typeof targetDriver._id}`);
      console.log(`   Ride ID: ${rideRequest._id}`);
      console.log(`   Booking ID: ${rideRequest.bookingId}`);

      // Send ride request to the driver using the new function
      const broadcastResult = await sendRideRequestToDriver(rideRequest, targetDriver._id);

      // Update notification tracking variables
      driverNotified = broadcastResult.success;

      console.log(`📊 Broadcast Result:`, broadcastResult);

      if (broadcastResult.success) {
        console.log(`✅ Ride request sent to driver ${targetDriver.fullName}`);
        console.log(`   Method: ${broadcastResult.method}`);
        console.log(`   Attempts: ${broadcastResult.attempt || 1}`);

        // Log the event
        logRideEvent(rideRequest._id, 'manual_booking_sent_to_driver', {
          bookingId: rideRequest.bookingId,
          driverId: targetDriver._id,
          driverName: targetDriver.fullName,
          driverQueuePosition: targetDriver.queuePosition,
          status: 'pending',
          method: broadcastResult.method
        });
      } else {
        // Driver notification failed (likely disconnected)
        // DON'T delete the ride - let it wait for driver to reconnect
        // The ride will be cleaned up by the normal expiry mechanism if driver doesn't respond
        console.warn(`⚠️ Failed to notify driver, but ride created: ${broadcastResult.error}`);
        console.log(`⏳ Ride ${rideRequest.bookingId} is waiting for driver ${targetDriver.fullName} to reconnect`);

        // Set warning message for response
        const errorMessage = broadcastResult.error || 'Failed to send ride request to driver';
        const isConnectivityIssue = errorMessage.includes('not online') || errorMessage.includes('not reachable');

        notificationWarning = isConnectivityIssue
          ? `Driver ${targetDriver.fullName} is not currently connected. They will see the request when they reconnect (within ${Math.round((rideRequest.expiresAt - Date.now()) / 1000)}s).`
          : `Could not notify driver: ${errorMessage}. Request is waiting.`;

        // Log the event as "waiting for driver"
        logRideEvent(rideRequest._id, 'manual_booking_waiting_for_driver', {
          bookingId: rideRequest.bookingId,
          driverId: targetDriver._id,
          driverName: targetDriver.fullName,
          reason: broadcastResult.error,
          status: 'pending_driver_connection',
          expiresAt: rideRequest.expiresAt
        });
      }
    }

    // Populate ride details for response
    const populatedRide = await RideRequest.findById(rideRequest._id)
      .populate('user', 'name phone');

    // Emit to admin room about the manual booking
    const io = getIO();
    if (io) {
      // Notify admins about the manual booking creation
      toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName || pickupStation).emit('manualBookingCreated', {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        status: rideRequest.status,
        targetDriver: targetDriver ? {
          id: targetDriver._id,
          name: targetDriver.fullName,
          phone: targetDriver.mobileNo,
          queuePosition: targetDriver.queuePosition
        } : null,
        user: {
          name: user.name,
          phone: user.phone
        },
        pickupLocation: rideRequest.pickupLocation,
        dropLocation: rideRequest.dropLocation,
        vehicleType: rideRequest.vehicleType,
        estimatedFare: rideRequest.estimatedFare,
        timestamp: new Date().toISOString()
      });
    }
    
    // Send SMS to customer with OTPs if ride was successfully created
    let smsResult = null;
    if (targetDriver && twilioSmsService.isConfigured()) {
      try {
        // Validate phone number before sending SMS
        const phoneValidation = twilioSmsService.validatePhoneNumber(user.phone);
        if (!phoneValidation.isValid) {
          console.warn(`⚠️ SMS skipped - invalid phone number: ${user.phone}`);
          smsResult = {
            success: false,
            skipped: true,
            reason: phoneValidation.error,
            phone: user.phone
          };

          // Log the SMS skip but don't fail the booking
          logError(populatedRide._id, 'sms_skipped_invalid_phone', {
            phone: user.phone,
            error: phoneValidation.error
          });
        } else {
          console.log(`📱 Sending booking confirmation SMS to ${phoneValidation.formatted}`);
          smsResult = await twilioSmsService.sendBookingOTP(
            user.phone,
            populatedRide.startOTP,
            populatedRide.endOTP,
            targetDriver.fullName,
            {
              rideId: populatedRide._id,
              adminId: req.admin?._id,
              adminName: req.admin?.name
            }
          );
        }

        if (smsResult.success) {
          console.log(`✅ SMS sent successfully to ${user.phone}`);

          // Log SMS success
          logRideEvent(populatedRide._id, 'sms_booking_sent', {
            phone: user.phone,
            messageId: smsResult.messageId,
            startOTP: populatedRide.startOTP,
            endOTP: populatedRide.endOTP,
            driverName: targetDriver.fullName
          });
        } else {
          console.error(`❌ Failed to send SMS to ${user.phone}:`, smsResult.error);

          // Log SMS failure
          logError(populatedRide._id, 'sms_booking_failed', {
            phone: user.phone,
            error: smsResult.error,
            errorCode: smsResult.errorCode
          });
        }
      } catch (smsError) {
        console.error('❌ SMS service error:', smsError.message);

        // Log SMS service error
        logError(populatedRide._id, 'sms_service_error', {
          phone: user.phone,
          error: smsError.message
        });
      }
    } else if (!twilioSmsService.isConfigured()) {
      console.warn('⚠️ SMS service not configured - skipping SMS');
    }

    // Build success message based on notification status
    let successMessage = 'Ride booked successfully';
    if (targetDriver) {
      successMessage = driverNotified
        ? `Request sent to driver ${targetDriver.fullName}`
        : `Request created for ${targetDriver.fullName} (waiting for driver to connect)`;
    }

    // Send success response
    res.json({
      success: true,
      message: successMessage,
      driverNotified: targetDriver ? driverNotified : null,
      warning: notificationWarning,
      booking: {
        _id: populatedRide._id,
        bookingId: populatedRide.bookingId,
        queueNumber: populatedRide.queueNumber,
        pickupLocation: populatedRide.pickupLocation,
        dropLocation: populatedRide.dropLocation,
        vehicleType: populatedRide.vehicleType,
        estimatedFare: populatedRide.estimatedFare,
        startOTP: populatedRide.startOTP,
        endOTP: populatedRide.endOTP,
        status: populatedRide.status,
        targetDriver: targetDriver ? {
          id: targetDriver._id,
          name: targetDriver.fullName,
          phone: targetDriver.mobileNo,
          queuePosition: targetDriver.queuePosition
        } : null,
        expiresAt: rideRequest.expiresAt, // 30 seconds from request sent
        userName: user.name,
        userPhone: user.phone,
        bookingSource: 'manual',
        smsStatus: smsResult ? {
          sent: smsResult.success,
          error: smsResult.success ? null : smsResult.error
        } : null
      }
    });

  } catch (error) {
    console.error('Manual booking error:', error);
    
    // Log the error with context
    logError(null, 'manual_booking_failed', {
      adminId: req.admin?._id,
      adminName: req.admin?.name,
      requestBody: req.body,
      errorMessage: error.message,
      errorStack: error.stack
    });
    
    res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: error.message
    });
  }
});

// Check if user exists by phone
router.get('/check-user/:phone', adminProtect, async (req, res) => {
  try {
    const { phone } = req.params;
    const user = await User.findOne({ phone });
    
    if (user) {
      res.json({
        exists: true,
        user: {
          _id: user._id,
          name: user.name,
          phone: user.phone
        }
      });
    } else {
      res.json({ exists: false });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error checking user',
      error: error.message
    });
  }
});

// Register new customer (quick registration during manual booking)
router.post('/register-customer', adminProtect, checkPermission(PERMISSIONS.RIDES_MANUAL_BOOKING), async (req, res) => {
  try {
    const { phone, name, email } = req.body;

    // Validate required fields
    if (!phone || !name) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and name are required'
      });
    }

    // Validate phone number format (10 digits starting with 6-9)
    const phoneRegex = /^[6-9]\d{9}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Must be 10 digits starting with 6-9'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Customer with this phone number already exists',
        user: {
          _id: existingUser._id,
          name: existingUser.name,
          phone: existingUser.phone,
          email: existingUser.email
        }
      });
    }

    // Create new user — only include email if actually provided
    const userData = {
      name,
      phone,
      password: phone, // Default password is phone number
      role: 'user',
      isPhoneVerified: true,
      createdBy: 'admin'
    };
    if (email && email.trim()) {
      userData.email = email.trim();
    }

    const newUser = new User(userData);
    await newUser.save();

    console.log(`✅ New customer registered by ${req.admin.name}: ${name} (${phone})`);

    res.status(201).json({
      success: true,
      message: 'Customer registered successfully',
      user: {
        _id: newUser._id,
        name: newUser.name,
        phone: newUser.phone,
        email: newUser.email
      }
    });
  } catch (error) {
    console.error('Error registering customer:', error);

    // Handle MongoDB duplicate key error on email
    if (error.code === 11000 && error.keyPattern && error.keyPattern.email) {
      return res.status(400).json({
        success: false,
        message: 'A user with this email already exists. Try without email.'
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Error registering customer'
    });
  }
});

// Get manual booking details
router.get('/manual-booking/:id', adminProtect, async (req, res) => {
  try {
    const booking = await RideRequest.findById(req.params.id)
      .populate('user', 'name phone')
      .populate('driver', 'name phone vehicleNumber vehicleType')
      .populate('pickupStation', 'name location');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!canAccessDoc(req.admin, booking)) return forbidden(res);

    res.json({
      success: true,
      booking
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error fetching booking',
      error: error.message
    });
  }
});

// Resend OTP via SMS for manual booking
router.post('/resend-otp/:rideId', adminProtect, async (req, res) => {
  try {
    const { rideId } = req.params;

    // Fetch ride details with populated user data
    const ride = await RideRequest.findById(rideId)
      .populate('user', 'name phone')
      .populate('driver', 'fullName name');

    if (!ride) {
      return res.status(404).json({
        success: false,
        message: 'Ride not found'
      });
    }

    if (!canAccessDoc(req.admin, ride)) return forbidden(res);

    // Check if ride has OTPs
    if (!ride.startOTP || !ride.endOTP) {
      return res.status(400).json({
        success: false,
        message: 'OTPs not available for this ride'
      });
    }

    // Check if user phone is available
    if (!ride.user || !ride.user.phone) {
      return res.status(400).json({
        success: false,
        message: 'Customer phone number not available'
      });
    }

    // Send resend OTP SMS if Twilio is configured
    let smsResult = null;
    if (twilioSmsService.isConfigured()) {
      try {
        // Validate phone number before sending SMS
        const phoneValidation = twilioSmsService.validatePhoneNumber(ride.user.phone);
        if (!phoneValidation.isValid) {
          return res.status(400).json({
            success: false,
            message: `Invalid phone number: ${phoneValidation.error}`
          });
        }

        console.log(`📱 Resending OTP SMS to ${phoneValidation.formatted}`);
        smsResult = await twilioSmsService.sendResendOTP(
          ride.user.phone,
          ride.startOTP,
          ride.endOTP,
          {
            rideId: ride._id,
            adminId: req.admin?._id,
            adminName: req.admin?.name,
            resendBy: 'admin'
          }
        );

        if (smsResult.success) {
          console.log(`✅ Resend OTP SMS sent successfully to ${ride.user.phone}`);

          // Log SMS success
          logRideEvent(ride._id, 'sms_otp_resent', {
            phone: ride.user.phone,
            messageId: smsResult.messageId,
            startOTP: ride.startOTP,
            endOTP: ride.endOTP,
            adminId: req.admin?._id,
            adminName: req.admin?.name
          });

          res.json({
            success: true,
            message: 'OTP resent successfully via SMS',
            phone: ride.user.phone,
            messageId: smsResult.messageId
          });
        } else {
          console.error(`❌ Failed to resend OTP SMS to ${ride.user.phone}:`, smsResult.error);

          // Log SMS failure
          logError(ride._id, 'sms_otp_resend_failed', {
            phone: ride.user.phone,
            error: smsResult.error,
            errorCode: smsResult.errorCode,
            adminId: req.admin?._id
          });

          res.status(500).json({
            success: false,
            message: 'Failed to send OTP via SMS',
            error: smsResult.error
          });
        }
      } catch (smsError) {
        console.error('❌ SMS service error during OTP resend:', smsError.message);

        // Log SMS service error
        logError(ride._id, 'sms_otp_resend_service_error', {
          phone: ride.user.phone,
          error: smsError.message,
          adminId: req.admin?._id
        });

        res.status(500).json({
          success: false,
          message: 'SMS service error',
          error: smsError.message
        });
      }
    } else {
      res.status(503).json({
        success: false,
        message: 'SMS service not configured'
      });
    }
  } catch (error) {
    console.error('❌ Error resending OTP:', error.message);
    res.status(500).json({
      success: false,
      message: 'Error resending OTP',
      error: error.message
    });
  }
});

// Send payment link via SMS
router.post('/send-payment-link', adminProtect, async (req, res) => {
  try {
    const { phone, customerName, amount, paymentLink } = req.body;

    // Validate required fields
    if (!phone || !amount || !paymentLink) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: phone, amount, or paymentLink'
      });
    }

    // Validate phone number format
    const phoneRegex = /^[6-9]\d{9}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format'
      });
    }

    // Check if Twilio SMS service is configured
    if (!twilioSmsService.isConfigured()) {
      return res.status(503).json({
        success: false,
        message: 'SMS service not configured'
      });
    }

    // Compose SMS message
    const smsMessage = `Hi ${customerName || 'Customer'},

Your GT3 Auto Booking fare is ₹${amount}.

Pay now using this link:
${paymentLink}

Scan QR or click link to pay via any UPI app (GPay, PhonePe, Paytm, BharatPe).

Thank you!
- GT3 Auto Booking`;

    // Send SMS
    console.log(`[Payment Link SMS] Sending to ${phone}...`);
    const smsResult = await twilioSmsService.sendSMS(phone, smsMessage);

    if (smsResult.success) {
      console.log(`✅ Payment link SMS sent successfully to ${phone}`);
      res.json({
        success: true,
        message: 'Payment link sent successfully',
        messageId: smsResult.messageId,
        phone: phone
      });
    } else {
      console.error(`❌ Failed to send payment link SMS:`, smsResult.error);
      res.status(500).json({
        success: false,
        message: 'Failed to send SMS',
        error: smsResult.error,
        errorCode: smsResult.errorCode
      });
    }
  } catch (error) {
    console.error('❌ Error sending payment link SMS:', error.message);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Cancel pending manual booking request (for switching drivers)
router.post('/cancel-pending/:rideId', adminProtect, checkPermission(PERMISSIONS.RIDES_MANUAL_BOOKING), async (req, res) => {
  try {
    const { rideId } = req.params;
    const { reason } = req.body;
    const adminId = req.admin._id;
    const adminName = req.admin.name;

    console.log(`\n=== ADMIN CANCELLING PENDING MANUAL BOOKING ===`);
    console.log(`Admin: ${adminName} (${adminId})`);
    console.log(`Ride ID: ${rideId}`);
    console.log(`Reason: ${reason || 'Admin wants to reassign'}`);

    // Find the ride request
    const rideRequest = await RideRequest.findById(rideId);

    if (!rideRequest) {
      return res.status(404).json({
        success: false,
        message: 'Ride request not found'
      });
    }

    if (!canAccessDoc(req.admin, rideRequest)) return forbidden(res);

    // Only allow cancelling pending manual bookings
    if (rideRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel ride in status: ${rideRequest.status}. Only pending rides can be cancelled.`
      });
    }

    if (rideRequest.bookingSource !== 'manual') {
      return res.status(400).json({
        success: false,
        message: 'This endpoint only supports manual bookings'
      });
    }

    // Update ride status to cancelled
    rideRequest.status = 'cancelled';
    rideRequest.cancelledBy = 'admin';
    rideRequest.cancelReason = reason || 'Admin cancelled to reassign driver';
    rideRequest.cancelledAt = new Date();
    await rideRequest.save();

    console.log(`✅ Ride ${rideRequest.bookingId} cancelled`);

    // Log the cancellation event
    logRideEvent(rideRequest.rideId || rideRequest._id, 'admin_cancelled_pending', {
      adminId,
      adminName,
      reason: reason || 'Admin cancelled to reassign driver',
      previousTargetDriverId: rideRequest.targetDriverId,
      previousTargetDriverName: rideRequest.targetDriverName
    });

    // Notify the target driver that the request was cancelled
    const io = getIO();
    if (io && rideRequest.targetDriverId) {
      io.to(`driver_${rideRequest.targetDriverId}`).emit('rideRequestCancelled', {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        reason: 'Admin cancelled and will reassign the booking',
        message: 'The ride request has been cancelled by admin',
        timestamp: new Date().toISOString()
      });
      console.log(`📢 Notified driver ${rideRequest.targetDriverName} about cancellation`);
    }

    // Notify admin room
    if (io) {
      io.to('adminRoom').emit('manualBookingCancelled', {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        cancelledBy: adminName,
        reason: reason || 'Admin cancelled to reassign driver',
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: 'Pending request cancelled successfully',
      cancelledBooking: {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        previousDriver: rideRequest.targetDriverName
      }
    });

  } catch (error) {
    console.error('❌ Error cancelling pending manual booking:', error);
    logError(req.params.rideId, error, {
      event: 'cancel_pending_manual_booking_failed',
      adminId: req.admin?._id
    });

    res.status(500).json({
      success: false,
      message: 'Failed to cancel pending request',
      error: error.message
    });
  }
});

// GET /api/admin/offline-requests - Get pending driver offline requests
router.get('/offline-requests', adminProtect, async (req, res) => {
  try {
    const DriverOfflineRequest = require('../../models/DriverOfflineRequest');

    const requests = await DriverOfflineRequest.find({
      status: 'pending'
    })
    .populate('driverId', 'fullName mobileNo vehicleNo vehicleType currentMetroBooth')
    .sort({ requestedAt: 1 });

    res.json({
      success: true,
      requests: requests.map(request => ({
        _id: request._id,
        driverId: request.driverId?._id || request.driverId,
        driverName: request.driverName || request.driverId?.fullName,
        driverPhone: request.driverPhone || request.driverId?.mobileNo,
        boothName: request.boothName,
        queuePosition: request.queuePosition,
        reason: request.reason,
        requestedAt: request.requestedAt,
        expiresAt: request.expiresAt
      })),
      count: requests.length
    });
  } catch (error) {
    console.error('Error fetching offline requests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch offline requests'
    });
  }
});

// ============================================
// FLEET MANAGER WORKFLOW ENDPOINTS
// ============================================

// POST /api/admin/submit-to-fleet-manager - Submit booking to Fleet Manager queue
// This creates a booking without driver assignment - Fleet Manager will assign driver
router.post('/submit-to-fleet-manager', adminProtect, checkPermission(PERMISSIONS.RIDES_MANUAL_BOOKING), pinPickupToPod, async (req, res) => {
  try {
    const {
      pickupStation,
      pickupLocation,
      dropLocation,
      dropCoordinates,
      vehicleType,
      estimatedFare,
      distance,
      userPhone,
      userName,
      existingUserId,
      paymentStatus,
      paymentMethod,
      fareBreakdown // Frontend sends fare breakdown to avoid recalculation mismatch
    } = req.body;

    // Validate phone number
    if (!userPhone) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    // Check if phone number is valid (10 digits starting with 6-9)
    const phoneRegex = /^[6-9]\d{9}$/;
    if (!phoneRegex.test(userPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Must be 10 digits starting with 6-9'
      });
    }

    console.log(`\n=== SUBMIT TO FLEET MANAGER ===`);
    console.log(`Admin: ${req.admin.name} (${req.admin._id})`);
    console.log(`Customer: ${userName} (${userPhone})`);
    console.log(`Vehicle: ${vehicleType}, Drop: ${dropLocation}`);

    // Find or create user
    let user;
    if (existingUserId) {
      user = await User.findById(existingUserId);
    } else {
      user = await User.findOne({ phone: userPhone });

      if (!user) {
        user = new User({
          name: userName,
          phone: userPhone,
          password: userPhone,
          role: 'user',
          isPhoneVerified: true,
          createdBy: 'admin'
        });
        await user.save();
        console.log(`✅ New customer created: ${userName}`);
      }
    }

    // Find pickup location
    const pickupLocationDoc = await PickupLocation.findOne({
      name: pickupStation,
      isActive: true
    });

    if (!pickupLocationDoc) {
      return res.status(400).json({
        success: false,
        message: `Pickup location '${pickupStation}' not found or inactive`
      });
    }

    // Generate OTPs and booking ID
    const startOTP = generateOTP();
    const endOTP = generateOTP();
    const bookingId = `MNL${Date.now()}${Math.floor(Math.random() * 100)}`;

    // Get queue number for the booth
    const queueEntry = await BoothQueue.findOneAndUpdate(
      { boothName: pickupStation },
      { $inc: { currentNumber: 1 } },
      { new: true, upsert: true }
    );

    const queueNumber = queueEntry.currentNumber;

    // Use frontend fare values if provided (to match what admin saw in UI)
    // Otherwise recalculate as fallback for backward compatibility
    let fareDetails;
    if (fareBreakdown && fareBreakdown.customerTotalFare) {
      // Use frontend values - this ensures UI fare matches database
      fareDetails = {
        customerTotalFare: fareBreakdown.customerTotalFare,
        driverFare: fareBreakdown.driverFare,
        baseFare: fareBreakdown.baseFare,
        gstAmount: fareBreakdown.gstAmount,
        commissionAmount: fareBreakdown.commissionAmount,
        nightChargeAmount: fareBreakdown.nightChargeAmount || 0,
        breakdown: fareBreakdown
      };
      console.log('📋 [FM] Using frontend fare values:', fareDetails.customerTotalFare);
    } else {
      // Fallback: recalculate (for backward compatibility)
      fareDetails = await calculateFare(vehicleType, distance, true, 0);
      console.log('📋 [FM] Recalculated fare:', fareDetails.customerTotalFare);
    }

    // Create the ride request with status 'pending_fm' (pending Fleet Manager)
    const rideRequest = new RideRequest({
      userId: user._id,
      user: user._id,
      userName: user.name,
      userPhone: user.phone,
      pickupStation: pickupLocationDoc._id,
      pickupLocation: {
        boothName: pickupLocationDoc.name,
        latitude: pickupLocationDoc.lat || 0,
        longitude: pickupLocationDoc.lng || 0
      },
      dropLocation: {
        address: dropLocation,
        latitude: dropCoordinates?.lat || 0,
        longitude: dropCoordinates?.lng || 0
      },
      vehicleType,
      estimatedFare: fareDetails.customerTotalFare,
      fare: fareDetails.driverFare,
      driverFare: fareDetails.driverFare,
      customerFare: fareDetails.customerTotalFare,
      baseFare: fareDetails.baseFare,
      gstAmount: fareDetails.gstAmount,
      commissionAmount: fareDetails.commissionAmount,
      nightChargeAmount: fareDetails.nightChargeAmount,
      fareBreakdown: fareDetails.breakdown,
      distance,
      startOTP,
      endOTP,
      rideId: bookingId,
      bookingId,
      queueNumber,
      bookingSource: 'manual',
      paymentStatus: paymentStatus || 'collected',
      paymentMethod: paymentMethod,
      paymentCollectedAt: paymentStatus === 'collected' ? new Date() : null,
      status: 'pending_fm', // NEW STATUS - waiting for Fleet Manager
      adminId: req.admin._id,
      adminName: req.admin.name,
      submittedToFmAt: new Date(), // Track when submitted to FM queue
      // No expiry for FM queue - stays open until FM acts
      expiresAt: null,
      isManualBookingExpired: false
    });

    await rideRequest.save();

    console.log(`✅ Booking ${bookingId} submitted to Fleet Manager queue`);
    console.log(`   Status: pending_fm`);
    console.log(`   Queue Number: ${queueNumber}`);

    // Log the event
    logRideEvent(rideRequest._id, 'submitted_to_fleet_manager', {
      bookingId: rideRequest.bookingId,
      adminId: req.admin._id,
      adminName: req.admin.name,
      pickupStation,
      dropLocation,
      vehicleType,
      customerFare: fareDetails.customerTotalFare,
      userPhone,
      userName,
      paymentMethod,
      paymentStatus
    });

    // Notify Fleet Managers via socket
    const io = getIO();
    if (io) {
      // Emit to all fleet managers and admins
      toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName || pickupStation).emit('newOpenBooking', {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        queueNumber: rideRequest.queueNumber,
        user: {
          name: user.name,
          phone: user.phone
        },
        pickupLocation: rideRequest.pickupLocation,
        dropLocation: rideRequest.dropLocation,
        vehicleType: rideRequest.vehicleType,
        estimatedFare: rideRequest.estimatedFare,
        distance: rideRequest.distance,
        paymentMethod: rideRequest.paymentMethod,
        paymentStatus: rideRequest.paymentStatus,
        createdBy: {
          id: req.admin._id,
          name: req.admin.name
        },
        submittedAt: rideRequest.submittedToFmAt,
        timestamp: new Date().toISOString()
      });

      console.log(`📢 Notified Fleet Managers about new open booking`);
    }

    res.json({
      success: true,
      message: 'Booking submitted to Fleet Manager for driver assignment',
      booking: {
        _id: rideRequest._id,
        bookingId: rideRequest.bookingId,
        queueNumber: rideRequest.queueNumber,
        pickupLocation: rideRequest.pickupLocation,
        dropLocation: rideRequest.dropLocation,
        vehicleType: rideRequest.vehicleType,
        estimatedFare: rideRequest.estimatedFare,
        distance: rideRequest.distance,
        startOTP: rideRequest.startOTP,
        endOTP: rideRequest.endOTP,
        status: rideRequest.status,
        userName: user.name,
        userPhone: user.phone,
        paymentMethod: rideRequest.paymentMethod,
        paymentStatus: rideRequest.paymentStatus,
        submittedToFmAt: rideRequest.submittedToFmAt,
        createdBy: {
          id: req.admin._id,
          name: req.admin.name
        }
      }
    });

  } catch (error) {
    console.error('❌ Submit to Fleet Manager error:', error);

    logError(null, 'submit_to_fleet_manager_failed', {
      adminId: req.admin?._id,
      adminName: req.admin?.name,
      requestBody: req.body,
      errorMessage: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to submit booking to Fleet Manager',
      error: error.message
    });
  }
});

// GET /api/admin/fleet-manager/open-bookings - Get all pending FM requests (for Fleet Manager)
router.get('/fleet-manager/open-bookings', adminProtect, async (req, res) => {
  try {
    console.log(`\n=== FLEET MANAGER: FETCHING OPEN BOOKINGS ===`);
    console.log(`Requested by: ${req.admin.name} (${req.admin.role})`);

    // Get all bookings with status 'pending_fm' sorted by newest first
    const openBookings = await RideRequest.find({
      status: 'pending_fm',
      bookingSource: 'manual',
      ...boothCondition(req.admin, 'pickupLocation.boothName')
    })
    .sort({ submittedToFmAt: -1 }) // Newest first
    .select({
      bookingId: 1,
      queueNumber: 1,
      userName: 1,
      userPhone: 1,
      pickupLocation: 1,
      dropLocation: 1,
      vehicleType: 1,
      estimatedFare: 1,
      driverFare: 1,
      distance: 1,
      paymentMethod: 1,
      paymentStatus: 1,
      submittedToFmAt: 1,
      adminName: 1,
      startOTP: 1,
      endOTP: 1
    });

    console.log(`✅ Found ${openBookings.length} open bookings`);

    res.json({
      success: true,
      count: openBookings.length,
      bookings: openBookings.map(booking => ({
        _id: booking._id,
        bookingId: booking.bookingId,
        queueNumber: booking.queueNumber,
        customer: {
          name: booking.userName,
          phone: booking.userPhone
        },
        pickupLocation: booking.pickupLocation,
        dropLocation: booking.dropLocation,
        vehicleType: booking.vehicleType,
        estimatedFare: booking.estimatedFare,
        driverFare: booking.driverFare,
        distance: booking.distance,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        submittedAt: booking.submittedToFmAt,
        createdBy: booking.adminName,
        startOTP: booking.startOTP,
        endOTP: booking.endOTP
      }))
    });

  } catch (error) {
    console.error('❌ Error fetching open bookings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch open bookings',
      error: error.message
    });
  }
});

// GET /api/admin/pending-fm-requests - Get all pending FM requests (for Admin sidebar)
router.get('/pending-fm-requests', adminProtect, async (req, res) => {
  try {
    // Get all pending FM requests from all admins (as per requirements)
    const pendingRequests = await RideRequest.find({
      status: 'pending_fm',
      bookingSource: 'manual',
      ...boothCondition(req.admin, 'pickupLocation.boothName')
    })
    .sort({ submittedToFmAt: -1 })
    .select({
      bookingId: 1,
      queueNumber: 1,
      userName: 1,
      userPhone: 1,
      pickupLocation: 1,
      dropLocation: 1,
      vehicleType: 1,
      estimatedFare: 1,
      submittedToFmAt: 1,
      adminId: 1,
      adminName: 1
    });

    res.json({
      success: true,
      count: pendingRequests.length,
      requests: pendingRequests.map(pending => ({
        _id: pending._id,
        bookingId: pending.bookingId,
        queueNumber: pending.queueNumber,
        customer: {
          name: pending.userName,
          phone: pending.userPhone
        },
        pickupLocation: pending.pickupLocation?.boothName,
        dropLocation: pending.dropLocation?.address,
        vehicleType: pending.vehicleType,
        estimatedFare: pending.estimatedFare,
        submittedAt: pending.submittedToFmAt,
        createdBy: {
          id: pending.adminId,
          name: pending.adminName
        },
        isOwnRequest: pending.adminId?.toString() === req.admin?._id?.toString()
      }))
    });

  } catch (error) {
    console.error('❌ Error fetching pending FM requests:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending requests',
      error: error.message
    });
  }
});

// POST /api/admin/cancel-fm-request/:rideId - Admin cancels a pending FM request
router.post('/cancel-fm-request/:rideId', adminProtect, checkPermission(PERMISSIONS.RIDES_MANUAL_BOOKING), async (req, res) => {
  try {
    const { rideId } = req.params;
    const adminId = req.admin._id;
    const adminName = req.admin.name;

    console.log(`\n=== ADMIN CANCELLING FM REQUEST ===`);
    console.log(`Admin: ${adminName} (${adminId})`);
    console.log(`Ride ID: ${rideId}`);

    const rideRequest = await RideRequest.findById(rideId);

    if (!rideRequest) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!canAccessDoc(req.admin, rideRequest)) return forbidden(res);

    // Only allow cancelling pending_fm requests
    if (rideRequest.status !== 'pending_fm') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel booking in status: ${rideRequest.status}. Only pending FM requests can be cancelled.`
      });
    }

    // Update status to cancelled_by_admin
    rideRequest.status = 'cancelled_by_admin';
    rideRequest.cancelledByAdminAt = new Date();
    rideRequest.cancelledAt = new Date();
    rideRequest.cancelledBy = 'admin';
    rideRequest.cancellationReason = 'Cancelled by admin before driver assignment';
    await rideRequest.save();

    console.log(`✅ Booking ${rideRequest.bookingId} cancelled by admin`);

    // Log the event
    logRideEvent(rideRequest._id, 'cancelled_by_admin', {
      bookingId: rideRequest.bookingId,
      adminId,
      adminName,
      previousStatus: 'pending_fm'
    });

    // Notify Fleet Managers that this booking was cancelled
    const io = getIO();
    if (io) {
      toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('bookingCancelledByAdmin', {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        cancelledBy: {
          id: adminId,
          name: adminName
        },
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      booking: {
        _id: rideRequest._id,
        bookingId: rideRequest.bookingId,
        status: rideRequest.status
      }
    });

  } catch (error) {
    console.error('❌ Error cancelling FM request:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel booking',
      error: error.message
    });
  }
});

// POST /api/admin/fleet-manager/cancel-booking/:rideId - Fleet Manager cancels a request
router.post('/fleet-manager/cancel-booking/:rideId', adminProtect, async (req, res) => {
  try {
    const { rideId } = req.params;
    const { reason } = req.body;
    const fmId = req.admin._id;
    const fmName = req.admin.name;

    console.log(`\n=== FLEET MANAGER CANCELLING BOOKING ===`);
    console.log(`Fleet Manager: ${fmName} (${fmId})`);
    console.log(`Ride ID: ${rideId}`);
    console.log(`Reason: ${reason || 'No reason provided'}`);

    if (!reason) {
      return res.status(400).json({
        success: false,
        message: 'Cancellation reason is required'
      });
    }

    const rideRequest = await RideRequest.findById(rideId);

    if (!rideRequest) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!canAccessDoc(req.admin, rideRequest)) return forbidden(res);

    // Only allow cancelling pending_fm requests
    if (rideRequest.status !== 'pending_fm') {
      return res.status(400).json({
        success: false,
        message: `Cannot cancel booking in status: ${rideRequest.status}. Only pending FM requests can be cancelled.`
      });
    }

    // Update status to cancelled_by_fm
    rideRequest.status = 'cancelled_by_fm';
    rideRequest.fmCancellationReason = reason;
    rideRequest.cancelledAt = new Date();
    rideRequest.cancelledBy = 'fleet_manager';
    rideRequest.cancellationReason = reason;
    await rideRequest.save();

    console.log(`✅ Booking ${rideRequest.bookingId} cancelled by Fleet Manager`);

    // Log the event
    logRideEvent(rideRequest._id, 'cancelled_by_fleet_manager', {
      bookingId: rideRequest.bookingId,
      fmId,
      fmName,
      reason,
      previousStatus: 'pending_fm'
    });

    // Notify the Admin who created the booking
    const io = getIO();
    if (io) {
      // Notify admin room
      toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('fmCancelledRequest', {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        reason: reason,
        cancelledBy: {
          id: fmId,
          name: fmName
        },
        originalCreator: {
          id: rideRequest.adminId,
          name: rideRequest.adminName
        },
        timestamp: new Date().toISOString()
      });

      // Also notify specific admin if they're logged in
      if (rideRequest.adminId) {
        io.to(`admin_${rideRequest.adminId}`).emit('fmCancelledRequest', {
          rideId: rideRequest._id,
          bookingId: rideRequest.bookingId,
          reason: reason,
          cancelledBy: {
            id: fmId,
            name: fmName
          },
          timestamp: new Date().toISOString()
        });
      }
    }

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      booking: {
        _id: rideRequest._id,
        bookingId: rideRequest.bookingId,
        status: rideRequest.status,
        cancellationReason: reason
      }
    });

  } catch (error) {
    console.error('❌ Error cancelling booking by FM:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel booking',
      error: error.message
    });
  }
});

// POST /api/admin/fleet-manager/assign-driver/:rideId - Fleet Manager assigns driver to booking
router.post('/fleet-manager/assign-driver/:rideId', adminProtect, async (req, res) => {
  try {
    const { rideId } = req.params;
    const { driverId } = req.body;
    const fmId = req.admin._id;
    const fmName = req.admin.name;

    console.log(`\n=== FLEET MANAGER ASSIGNING DRIVER ===`);
    console.log(`Fleet Manager: ${fmName} (${fmId})`);
    console.log(`Ride ID: ${rideId}`);
    console.log(`Driver ID: ${driverId}`);

    if (!driverId) {
      return res.status(400).json({
        success: false,
        message: 'Driver ID is required'
      });
    }

    const rideRequest = await RideRequest.findById(rideId);

    if (!rideRequest) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!canAccessDoc(req.admin, rideRequest)) return forbidden(res);

    // Only allow assigning to pending_fm requests
    if (rideRequest.status !== 'pending_fm') {
      return res.status(400).json({
        success: false,
        message: `Cannot assign driver to booking in status: ${rideRequest.status}`
      });
    }

    // Validate the driver
    const driver = await Driver.findById(driverId);
    if (!driver) {
      return res.status(404).json({
        success: false,
        message: 'Driver not found'
      });
    }

    // Check driver availability
    if (driver.currentRide) {
      return res.status(400).json({
        success: false,
        message: 'Driver already has an active ride'
      });
    }

    if (driver.vehicleType !== rideRequest.vehicleType) {
      return res.status(400).json({
        success: false,
        message: `Vehicle type mismatch: Driver has ${driver.vehicleType}, booking needs ${rideRequest.vehicleType}`
      });
    }

    // Update ride with target driver and set expiry for driver response
    // Keep status as 'pending_fm' while waiting for driver response
    // Status will change to 'driver_assigned' when driver accepts
    rideRequest.targetDriverId = driver._id;
    rideRequest.targetDriverName = driver.fullName;
    rideRequest.fmAssignedAt = new Date();
    rideRequest.assignedByFmId = fmId;
    rideRequest.assignedByFmName = fmName;
    // Set 60 second expiry for driver to respond
    rideRequest.expiresAt = new Date(Date.now() + 60 * 1000);
    rideRequest.isManualBookingExpired = false;
    await rideRequest.save();

    console.log(`✅ Driver ${driver.fullName} assigned to booking ${rideRequest.bookingId}`);

    // Log the event
    logRideEvent(rideRequest._id, 'driver_assigned_by_fm', {
      bookingId: rideRequest.bookingId,
      fmId,
      fmName,
      driverId: driver._id,
      driverName: driver.fullName,
      driverQueuePosition: driver.queuePosition
    });

    // Send ride request to driver
    const broadcastResult = await sendRideRequestToDriver(rideRequest, driver._id);

    console.log(`📊 Broadcast Result:`, broadcastResult);

    // Notify admins about driver assignment
    const io = getIO();
    if (io) {
      toAdmins(io, 'admin-room', rideRequest.pickupLocation?.boothName).emit('fmAssignedDriver', {
        rideId: rideRequest._id,
        bookingId: rideRequest.bookingId,
        driver: {
          id: driver._id,
          name: driver.fullName,
          phone: driver.mobileNo,
          vehicleNo: driver.vehicleNo,
          queuePosition: driver.queuePosition
        },
        assignedBy: {
          id: fmId,
          name: fmName
        },
        expiresAt: rideRequest.expiresAt,
        driverNotified: broadcastResult.success,
        timestamp: new Date().toISOString()
      });

      // Notify specific admin who created the booking
      if (rideRequest.adminId) {
        io.to(`admin_${rideRequest.adminId}`).emit('fmAssignedDriver', {
          rideId: rideRequest._id,
          bookingId: rideRequest.bookingId,
          driver: {
            id: driver._id,
            name: driver.fullName,
            phone: driver.mobileNo,
            vehicleNo: driver.vehicleNo,
            queuePosition: driver.queuePosition
          },
          assignedBy: {
            id: fmId,
            name: fmName
          },
          expiresAt: rideRequest.expiresAt,
          driverNotified: broadcastResult.success,
          timestamp: new Date().toISOString()
        });
      }
    }

    res.json({
      success: true,
      message: broadcastResult.success
        ? `Driver ${driver.fullName} notified. Waiting for response.`
        : `Driver assigned but notification pending. Driver will see request when online.`,
      driverNotified: broadcastResult.success,
      booking: {
        _id: rideRequest._id,
        bookingId: rideRequest.bookingId,
        status: rideRequest.status,
        driver: {
          id: driver._id,
          name: driver.fullName,
          phone: driver.mobileNo,
          vehicleNo: driver.vehicleNo,
          queuePosition: driver.queuePosition
        },
        expiresAt: rideRequest.expiresAt,
        startOTP: rideRequest.startOTP,
        endOTP: rideRequest.endOTP
      }
    });

  } catch (error) {
    console.error('❌ Error assigning driver:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign driver',
      error: error.message
    });
  }
});

// GET /api/admin/fleet-manager/booking/:rideId - Get single booking details for FM
router.get('/fleet-manager/booking/:rideId', adminProtect, async (req, res) => {
  try {
    const { rideId } = req.params;

    const booking = await RideRequest.findById(rideId);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!canAccessDoc(req.admin, booking)) return forbidden(res);

    res.json({
      success: true,
      booking: {
        _id: booking._id,
        bookingId: booking.bookingId,
        queueNumber: booking.queueNumber,
        status: booking.status,
        customer: {
          name: booking.userName,
          phone: booking.userPhone
        },
        pickupLocation: booking.pickupLocation,
        dropLocation: booking.dropLocation,
        vehicleType: booking.vehicleType,
        estimatedFare: booking.estimatedFare,
        driverFare: booking.driverFare,
        distance: booking.distance,
        paymentMethod: booking.paymentMethod,
        paymentStatus: booking.paymentStatus,
        startOTP: booking.startOTP,
        endOTP: booking.endOTP,
        submittedAt: booking.submittedToFmAt,
        createdBy: booking.adminName,
        targetDriver: booking.targetDriverId ? {
          id: booking.targetDriverId,
          name: booking.targetDriverName
        } : null,
        expiresAt: booking.expiresAt
      }
    });

  } catch (error) {
    console.error('❌ Error fetching booking:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch booking',
      error: error.message
    });
  }
});

module.exports = router;