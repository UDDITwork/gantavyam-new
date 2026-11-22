// controllers/adminController.js
const Driver = require('../models/Driver');
const User = require('../models/User');
const RideRequest = require('../models/RideRequest');
const RideHistory = require('../models/RideHistory');
const BoothQueue = require('../models/BoothQueue');
const PickupLocation = require('../models/PickupLocation');
const { createContextLogger } = require('../config/logger');

const logger = createContextLogger('AdminController');

const { isExecutive } = require('../utils/podScope');

// Personal, bank and document details an executive does not need to run a pickup point
const EXECUTIVE_HIDDEN_DRIVER_FIELDS = [
  'aadhaarNo', 'aadhaarPhotoFront', 'aadhaarPhotoBack', 'bankDetails',
  'drivingLicenseNo', 'drivingLicensePhoto', 'permitNo', 'permitPhoto',
  'fitnessCertificateNo', 'fitnessCertificatePhoto', 'insurancePolicyNo', 'insurancePolicyPhoto',
  'registrationCertificatePhoto', 'pushSubscription', 'password'
];

// @desc    Get all drivers
// @route   GET /api/admin/drivers
// @access  Private (Admin only)
exports.getAllDrivers = async (req, res) => {
  try {
    logger.info('Admin fetching all drivers', { adminId: req.admin?.id });
    // Drivers are one shared pool: an executive sees every driver, but without identity / bank / document details
    let drivers = await Driver.find().select('-password');
    if (isExecutive(req.admin)) {
      drivers = drivers.map((driver) => {
        const plain = typeof driver.toObject === 'function' ? driver.toObject() : { ...driver };
        EXECUTIVE_HIDDEN_DRIVER_FIELDS.forEach((field) => delete plain[field]);
        return plain;
      });
    }

    logger.info('Successfully fetched drivers', { count: drivers.length });
    res.status(200).json({
      success: true,
      count: drivers.length,
      data: drivers
    });
  } catch (error) {
    logger.error('Error fetching drivers', { 
      error: error.message, 
      stack: error.stack,
      adminId: req.admin?.id 
    });
    res.status(500).json({
      success: false,
      error: 'Server error while fetching drivers'
    });
  }
};

// @desc    Get driver by ID
// @route   GET /api/admin/drivers/:id
// @access  Private (Admin only)
exports.getDriverById = async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.id).select('-password');
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: driver
    });
  } catch (error) {
    console.error('Error fetching driver:', error);
    
    // Check if error is due to invalid ID format
    if (error.kind === 'ObjectId') {
      return res.status(400).json({
        success: false,
        error: 'Invalid driver ID format'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Server error while fetching driver'
    });
  }
};

// @desc    Get all users
// @route   GET /api/admin/users
// @access  Private (Admin only)
exports.getAllUsers = async (req, res) => {
  try {
    logger.info('Admin fetching all users', { adminId: req.admin?.id });
    const users = await User.find().select('-password');
    
    logger.info('Successfully fetched users', { count: users.length });
    res.status(200).json({
      success: true,
      count: users.length,
      data: users
    });
  } catch (error) {
    logger.error('Error fetching users', { 
      error: error.message, 
      stack: error.stack,
      adminId: req.admin?.id 
    });
    res.status(500).json({
      success: false,
      error: 'Server error while fetching users'
    });
  }
};

// @desc    Get user by ID
// @route   GET /api/admin/users/:id
// @access  Private (Admin only)
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    
    // Check if error is due to invalid ID format
    if (error.kind === 'ObjectId') {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID format'
      });
    }
    
    res.status(500).json({
      success: false,
      error: 'Server error while fetching user'
    });
  }
};

// @desc    Update driver verification status
// @route   PUT /api/admin/drivers/:id/verify
// @access  Private (Admin only)
exports.verifyDriver = async (req, res) => {
  try {
    const { isVerified } = req.body;
    
    if (isVerified === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Please provide isVerified field'
      });
    }
    
    const driver = await Driver.findByIdAndUpdate(
      req.params.id,
      { 
        isVerified: isVerified,
        $set: { 
          lastRenewalDate: isVerified ? Date.now() : undefined 
        }
      },
      { new: true }
    );
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    res.status(200).json({
      success: true,
      message: `Driver ${isVerified ? 'verified' : 'unverified'} successfully`,
      data: driver
    });
  } catch (error) {
    console.error('Error updating driver verification status:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while updating driver verification status'
    });
  }
};

// @desc    Delete driver
// @route   DELETE /api/admin/drivers/:id
// @access  Private (Admin only)
exports.deleteDriver = async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.id);
    
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: 'Driver not found'
      });
    }
    
    await Driver.findByIdAndDelete(req.params.id);
    
    res.status(200).json({
      success: true,
      message: 'Driver deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting driver:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while deleting driver'
    });
  }
};

// @desc    Get dashboard statistics
// @route   GET /api/admin/dashboard/stats
// @access  Private (Admin only)
exports.getDashboardStats = async (req, res) => {
  try {
    logger.info('Admin fetching dashboard statistics', { adminId: req.admin?.id });

    // A ride that is completed leaves the ride requests and is kept in the ride history, so every ride
    // figure on the dashboard counts both places.
    const [userCount, driverCount, requestCount, historyCount, pendingDrivers] = await Promise.all([
      User.countDocuments(),
      Driver.countDocuments({ isVerified: true }),
      RideRequest.countDocuments(),
      RideHistory.countDocuments(),
      Driver.countDocuments({ isVerified: false })
    ]);
    const rideCount = requestCount + historyCount;

    // Get today's ride count
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayRequestFilter = { createdAt: { $gte: today, $lt: tomorrow } };
    const todayHistoryFilter = { 'timestamps.requested': { $gte: today, $lt: tomorrow } };
    const completedRequestStatuses = ['completed', 'ride_ended'];
    const cancelledRequestStatuses = ['cancelled', 'cancelled_by_admin', 'cancelled_by_fm', 'cancelled_by_user', 'cancelled_by_driver'];

    const [todayRequests, todayHistory] = await Promise.all([
      RideRequest.countDocuments(todayRequestFilter),
      RideHistory.countDocuments(todayHistoryFilter)
    ]);
    const todayRides = todayRequests + todayHistory;

    // Get ride counts by status
    const [activeRides, completedRequests, cancelledRequests, completedHistory, cancelledHistory] = await Promise.all([
      RideRequest.countDocuments({
        status: { $in: ['pending', 'pending_fm', 'driver_assigned', 'ride_started'] }
      }),
      RideRequest.countDocuments({ status: { $in: completedRequestStatuses } }),
      RideRequest.countDocuments({ status: { $in: cancelledRequestStatuses } }),
      RideHistory.countDocuments({ status: 'completed' }),
      RideHistory.countDocuments({ status: 'cancelled' })
    ]);
    const completedRides = completedRequests + completedHistory;
    const cancelledRides = cancelledRequests + cancelledHistory;

    // Get online drivers count
    const activeDrivers = await Driver.countDocuments({ isOnline: true, isVerified: true });

    // Get today's completed and cancelled rides
    const [completedTodayRequests, cancelledTodayRequests, completedTodayHistory, cancelledTodayHistory] = await Promise.all([
      RideRequest.countDocuments({ ...todayRequestFilter, status: { $in: completedRequestStatuses } }),
      RideRequest.countDocuments({ ...todayRequestFilter, status: { $in: cancelledRequestStatuses } }),
      RideHistory.countDocuments({ ...todayHistoryFilter, status: 'completed' }),
      RideHistory.countDocuments({ ...todayHistoryFilter, status: 'cancelled' })
    ]);
    const completedToday = completedTodayRequests + completedTodayHistory;
    const cancelledToday = cancelledTodayRequests + cancelledTodayHistory;

    // Get recent rides for activity feed (open and cancelled requests together with the latest completed rides)
    const [recentRequests, recentHistory] = await Promise.all([
      RideRequest.find()
        .populate('userId', 'name')
        .populate('driverId', 'name')
        .sort({ createdAt: -1 })
        .limit(5)
        .select('status pickupLocation destination createdAt userId driverId'),
      RideHistory.find()
        .populate('userId', 'name')
        .sort({ 'timestamps.requested': -1 })
        .limit(5)
        .select('status pickupLocation dropLocation timestamps userId driverName')
    ]);
    const recentRides = [
      ...recentRequests,
      ...recentHistory.map((ride) => ({
        _id: ride._id,
        status: ride.status,
        pickupLocation: ride.pickupLocation,
        destination: ride.dropLocation && ride.dropLocation.address,
        createdAt: ride.timestamps && ride.timestamps.requested,
        userId: ride.userId,
        driverId: ride.driverName ? { name: ride.driverName } : null
      }))
    ]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 5);

    const stats = {
      userCount,
      driverCount,
      totalRides: rideCount,
      pendingApprovals: pendingDrivers,
      todayRides,
      activeRides,
      activeDrivers,
      completedToday,
      cancelledToday,
      recentActivity: recentRides,
      // Stats in format expected by RideManagement.js
      total: rideCount,
      completed: completedRides,
      active: activeRides,
      cancelled: cancelledRides
    };

    logger.info('Successfully fetched dashboard stats', { stats: Object.keys(stats) });

    res.status(200).json({
      success: true,
      data: stats
    });

  } catch (error) {
    logger.error('Error fetching dashboard stats', { 
      error: error.message, 
      stack: error.stack,
      adminId: req.admin?.id 
    });
    res.status(500).json({
      success: false,
      error: 'Server error while fetching dashboard statistics'
    });
  }
};

// @desc    Get booth performance metrics
// @route   GET /api/admin/booths/performance
// @access  Private (Admin only)
exports.getBoothPerformance = async (req, res) => {
  try {
    const { days = 7 } = req.query;
    
    logger.info('Admin fetching booth performance', { adminId: req.admin?.id, days });

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // Get ride counts by booth
    const boothPerformance = await RideRequest.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate },
          pickupLocation: { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: '$pickupLocation',
          totalRides: { $sum: 1 },
          completedRides: {
            $sum: { $cond: [{ $eq: ['$status', 'ride_ended'] }, 1, 0] }
          },
          cancelledRides: {
            $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] }
          },
          avgFare: { $avg: '$totalFare' }
        }
      },
      {
        $addFields: {
          completionRate: {
            $cond: [
              { $eq: ['$totalRides', 0] },
              0,
              { $multiply: [{ $divide: ['$completedRides', '$totalRides'] }, 100] }
            ]
          }
        }
      },
      { $sort: { totalRides: -1 } },
      { $limit: 20 }
    ]);

    // Get booth queue status for today
    const today = new Date().toISOString().split('T')[0];
    const boothQueues = await BoothQueue.find({ date: today });

    // Combine performance data with queue status
    const combinedData = boothPerformance.map(booth => {
      const queueData = boothQueues.find(q => q.boothName === booth._id);
      return {
        ...booth,
        queueInfo: queueData ? queueData.getQueueStatus() : null
      };
    });

    logger.info('Successfully fetched booth performance', { boothCount: combinedData.length });

    res.status(200).json({
      success: true,
      data: {
        performance: combinedData,
        period: `${days} days`,
        totalBooths: combinedData.length
      }
    });

  } catch (error) {
    logger.error('Error fetching booth performance', { 
      error: error.message, 
      stack: error.stack,
      adminId: req.admin?.id 
    });
    res.status(500).json({
      success: false,
      error: 'Server error while fetching booth performance'
    });
  }
};