const express = require('express');
const router = express.Router();
const RideRequest = require('../../models/RideRequest');
const RideHistory = require('../../models/RideHistory');
const { adminProtect } = require('../../middleware/auth');

// @desc    Get financial summary
// @route   GET /api/admin/financial/summary
// @access  Private (Admin only)
router.get('/summary', adminProtect, async (req, res) => {
  try {
    // Accept period parameter OR custom date range for filter functionality
    const { period = 'today', vehicleType, status, startDate: customStart, endDate: customEnd } = req.query;

    console.log('📊 [Financial API] Getting financial summary');
    console.log('Query params:', { period, customStart, customEnd });

    // Calculate date range based on period OR use custom dates
    const now = new Date();
    let startDate, endDate;

    // If custom dates are provided, use them (priority over period)
    if (customStart && customEnd) {
      startDate = new Date(customStart);
      endDate = new Date(customEnd);
      console.log('📊 Using custom date range:', { startDate: startDate.toISOString(), endDate: endDate.toISOString() });
    } else {
      // Use period-based calculation
      endDate = now;
      startDate = new Date();

      switch (period) {
        case 'today':
          // Today: Start of today to now
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
          break;
        case 'week':
          // Last 7 days
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'month':
          // Current month: 1st of this month to now
          startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
          break;
        case 'year':
          // Financial Year: April 1st to March 31st
          // If current month is Jan-Mar, FY started previous year
          const currentMonth = now.getMonth(); // 0-indexed (0 = Jan, 3 = Apr)
          const fyYear = currentMonth >= 3 ? now.getFullYear() : now.getFullYear() - 1;
          startDate = new Date(fyYear, 3, 1, 0, 0, 0); // April 1st
          break;
        default:
          // Default to today
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      }
      console.log('📊 Using period-based date range:', period);
    }

    console.log('Date range:', { startDate: startDate.toISOString(), endDate: endDate.toISOString() });

    // Build query filter - only completed rides for financial metrics
    const filter = {
      createdAt: { $gte: startDate, $lte: endDate },
      status: 'completed'
    };

    if (vehicleType && vehicleType !== 'all') {
      filter.vehicleType = vehicleType;
    }

    // Get rides from both RideRequest and RideHistory
    const [activeRides, historicalRides] = await Promise.all([
      RideRequest.find(filter),
      RideHistory.find(filter)
    ]);

    const allRides = [...activeRides, ...historicalRides];

    // Initialize financial summary with all required metrics
    let financialSummary = {
      // Core metrics
      totalRevenue: 0,
      driverEarnings: 0,
      platformRevenue: 0,
      totalCommission: 0, // Kept at 0 for backward compat — no commission in new formula
      totalGST: 0,        // Kept at 0 for backward compat — no GST in new formula
      totalNightCharges: 0,

      // Ride counts
      totalRides: allRides.length,
      completedRides: 0,
      cancelledRides: 0,

      // Payment tracking
      pendingCollections: 0,
      collectedAmount: 0,

      // NEW: Cash vs Online payments
      cashPayments: 0,
      onlinePayments: 0,
      cashRides: 0,
      onlineRides: 0,

      // Calculated metrics
      averageFare: 0,
      averageDistance: 0,
      netProfit: 0,
      completionRate: 0
    };

    // Process each ride
    allRides.forEach(ride => {
      const driverFare = ride.driverFare || ride.fare || 0;
      const customerFare = ride.customerFare || ride.estimatedFare || 0;
      const nightCharge = ride.nightChargeAmount || 0;
      // Platform earns the spread (customerFare - driverFare)
      const platformEarning = ride.platformEarning != null
        ? ride.platformEarning
        : Math.max(0, customerFare - driverFare);

      // Core financial metrics
      financialSummary.totalRevenue += customerFare;
      financialSummary.driverEarnings += driverFare;
      financialSummary.platformRevenue += platformEarning;
      financialSummary.totalNightCharges += nightCharge;
      // totalCommission and totalGST stay 0 (no commission/GST in new formula)

      // Distance tracking
      if (ride.distance) {
        financialSummary.averageDistance += ride.distance;
      }

      // Status tracking
      if (ride.status === 'completed') {
        financialSummary.completedRides++;

        // Payment status tracking
        if (ride.paymentStatus === 'collected' || ride.paymentStatus === 'online') {
          financialSummary.collectedAmount += customerFare;
        } else {
          financialSummary.pendingCollections += customerFare;
        }
      } else if (ride.status === 'cancelled') {
        financialSummary.cancelledRides++;
      }

      // Payment method tracking (cash vs online)
      const paymentMethod = (ride.paymentMethod || 'cash').toLowerCase();
      if (paymentMethod === 'cash') {
        financialSummary.cashPayments += customerFare;
        financialSummary.cashRides++;
      } else if (paymentMethod === 'online' || paymentMethod === 'upi' || paymentMethod === 'card') {
        financialSummary.onlinePayments += customerFare;
        financialSummary.onlineRides++;
      } else {
        // Default to cash if payment method is unknown
        financialSummary.cashPayments += customerFare;
        financialSummary.cashRides++;
      }
    });

    // Calculate averages
    if (financialSummary.totalRides > 0) {
      financialSummary.averageFare = Math.round(financialSummary.totalRevenue / financialSummary.totalRides);
      financialSummary.averageDistance = Math.round(financialSummary.averageDistance / financialSummary.totalRides * 10) / 10;
    }

    // Calculate completion rate
    financialSummary.completionRate = financialSummary.totalRides > 0
      ? Math.round(financialSummary.completedRides / financialSummary.totalRides * 100)
      : 0;

    // Net Profit = Platform Revenue (which IS Revenue − Driver earnings already)
    financialSummary.netProfit = financialSummary.platformRevenue;

    console.log(`✅ Financial summary calculated for ${allRides.length} completed rides (period: ${period})`);

    res.json({
      success: true,
      data: financialSummary,
      period,
      dateRange: {
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString()
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error getting financial summary:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting financial summary',
      error: error.message
    });
  }
});

// @desc    Get revenue trends
// @route   GET /api/admin/financial/trends
// @access  Private (Admin only)
router.get('/trends', adminProtect, async (req, res) => {
  try {
    const { period = 'week', groupBy = 'day', startDate: customStart, endDate: customEnd } = req.query;

    console.log('📈 [Financial API] Getting revenue trends');
    console.log('Parameters:', { period, groupBy, customStart, customEnd });

    // Calculate date range
    const now = new Date();
    let startDate, endDate;

    // If custom dates are provided, use them (priority over period)
    if (customStart && customEnd) {
      startDate = new Date(customStart);
      endDate = new Date(customEnd);
      console.log('📈 Using custom date range for trends:', { startDate: startDate.toISOString(), endDate: endDate.toISOString() });
    } else {
      // Use period-based calculation
      endDate = now;
      startDate = new Date();

      switch (period) {
        case 'day':
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          startDate.setHours(0, 0, 0, 0);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
          break;
        case 'quarter':
          startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1, 0, 0, 0);
          break;
        case 'year':
          // Financial Year: April 1st
          const currentMonth = now.getMonth();
          const fyYear = currentMonth >= 3 ? now.getFullYear() : now.getFullYear() - 1;
          startDate = new Date(fyYear, 3, 1, 0, 0, 0);
          break;
        default:
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          startDate.setHours(0, 0, 0, 0);
      }
      console.log('📈 Using period-based date range:', period);
    }

    console.log('Trends date range:', { startDate: startDate.toISOString(), endDate: (endDate || now).toISOString() });

    // Use endDate if set, otherwise use now
    if (!endDate) {
      endDate = now;
    }

    // Aggregation pipeline for COMPLETED rides (for revenue)
    const revenuePipeline = [
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate },
          status: 'completed'
        }
      }
    ];

    // Aggregation pipeline for ALL rides (for ride count)
    const ridesPipeline = [
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate }
        }
      }
    ];

    // Use revenue pipeline for main aggregation
    const pipeline = revenuePipeline;

    // Add grouping stage based on groupBy parameter
    let groupStage = {};
    if (groupBy === 'hour') {
      groupStage = {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' },
            hour: { $hour: '$createdAt' }
          },
          revenue: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } },
          driverEarnings: { $sum: { $ifNull: ['$driverFare', '$fare'] } },
          platformRevenue: {
            $sum: {
              $max: [
                0,
                {
                  $subtract: [
                    { $ifNull: ['$customerFare', '$estimatedFare'] },
                    { $ifNull: ['$driverFare', '$fare'] }
                  ]
                }
              ]
            }
          },
          rides: { $sum: 1 },
          avgFare: { $avg: { $ifNull: ['$customerFare', '$estimatedFare'] } }
        }
      };
    } else if (groupBy === 'day') {
      groupStage = {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          revenue: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } },
          driverEarnings: { $sum: { $ifNull: ['$driverFare', '$fare'] } },
          platformRevenue: {
            $sum: {
              $max: [
                0,
                {
                  $subtract: [
                    { $ifNull: ['$customerFare', '$estimatedFare'] },
                    { $ifNull: ['$driverFare', '$fare'] }
                  ]
                }
              ]
            }
          },
          rides: { $sum: 1 },
          avgFare: { $avg: { $ifNull: ['$customerFare', '$estimatedFare'] } }
        }
      };
    } else if (groupBy === 'week') {
      groupStage = {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            week: { $week: '$createdAt' }
          },
          revenue: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } },
          driverEarnings: { $sum: { $ifNull: ['$driverFare', '$fare'] } },
          platformRevenue: {
            $sum: {
              $max: [
                0,
                {
                  $subtract: [
                    { $ifNull: ['$customerFare', '$estimatedFare'] },
                    { $ifNull: ['$driverFare', '$fare'] }
                  ]
                }
              ]
            }
          },
          rides: { $sum: 1 },
          avgFare: { $avg: { $ifNull: ['$customerFare', '$estimatedFare'] } }
        }
      };
    } else {
      groupStage = {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' }
          },
          revenue: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } },
          driverEarnings: { $sum: { $ifNull: ['$driverFare', '$fare'] } },
          platformRevenue: {
            $sum: {
              $max: [
                0,
                {
                  $subtract: [
                    { $ifNull: ['$customerFare', '$estimatedFare'] },
                    { $ifNull: ['$driverFare', '$fare'] }
                  ]
                }
              ]
            }
          },
          rides: { $sum: 1 },
          avgFare: { $avg: { $ifNull: ['$customerFare', '$estimatedFare'] } }
        }
      };
    }

    pipeline.push(groupStage);
    pipeline.push({ $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } });

    // Simple group stage for counting ALL rides (any status)
    const ridesCountGroupStage = {
      $group: {
        _id: groupBy === 'day' ? {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' }
        } : groupBy === 'hour' ? {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
          hour: { $hour: '$createdAt' }
        } : {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' }
        },
        totalRides: { $sum: 1 }
      }
    };

    // Build rides count pipeline (ALL rides, any status)
    const allRidesPipeline = [
      { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
      ridesCountGroupStage,
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
    ];

    // Execute aggregations on both collections
    const [activeTrends, historicalTrends, activeAllRides, historicalAllRides] = await Promise.all([
      RideRequest.aggregate(pipeline),
      RideHistory.aggregate(pipeline),
      RideRequest.aggregate(allRidesPipeline),
      RideHistory.aggregate(allRidesPipeline)
    ]);

    // Combine revenue trends (completed rides only)
    const revenueTrendData = [...activeTrends, ...historicalTrends];

    // Combine all rides count
    const allRidesData = [...activeAllRides, ...historicalAllRides];

    // Create a map of date -> total rides count
    const ridesCountMap = {};
    allRidesData.forEach(item => {
      let dateKey = '';
      if (groupBy === 'day') {
        dateKey = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
      } else if (groupBy === 'hour') {
        dateKey = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')} ${String(item._id.hour).padStart(2, '0')}:00`;
      } else {
        dateKey = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      }
      ridesCountMap[dateKey] = (ridesCountMap[dateKey] || 0) + item.totalRides;
    });

    // Format the revenue data and merge with rides count
    const formattedData = revenueTrendData.map(item => {
      let dateLabel = '';
      if (groupBy === 'hour') {
        dateLabel = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')} ${String(item._id.hour).padStart(2, '0')}:00`;
      } else if (groupBy === 'day') {
        dateLabel = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
      } else if (groupBy === 'week') {
        dateLabel = `${item._id.year}-W${String(item._id.week).padStart(2, '0')}`;
      } else {
        dateLabel = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
      }

      return {
        date: dateLabel,
        revenue: Math.round(item.revenue || 0),
        driverEarnings: Math.round(item.driverEarnings || 0),
        platformRevenue: Math.round(item.platformRevenue || 0),
        rides: ridesCountMap[dateLabel] || item.rides || 0, // Use total rides count
        completedRides: item.rides || 0, // Original completed rides count
        averageFare: Math.round(item.avgFare || 0)
      };
    });

    // Also include dates that have rides but no completed rides (no revenue)
    Object.keys(ridesCountMap).forEach(dateKey => {
      if (!formattedData.find(d => d.date === dateKey)) {
        formattedData.push({
          date: dateKey,
          revenue: 0,
          driverEarnings: 0,
          platformRevenue: 0,
          rides: ridesCountMap[dateKey],
          completedRides: 0,
          averageFare: 0
        });
      }
    });

    // Sort by date
    formattedData.sort((a, b) => new Date(a.date) - new Date(b.date));

    console.log(`✅ Trends calculated: ${formattedData.length} data points (rides from all statuses)`);

    res.json({
      success: true,
      data: formattedData,
      period,
      groupBy,
      dateRange: { startDate, endDate }
    });

  } catch (error) {
    console.error('❌ Error getting revenue trends:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting revenue trends',
      error: error.message
    });
  }
});

// @desc    Get payment analytics
// @route   GET /api/admin/financial/payment-analytics
// @access  Private (Admin only)
router.get('/payment-analytics', adminProtect, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    console.log('💳 [Financial API] Getting payment analytics');

    // Build date filter
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) {
        dateFilter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        dateFilter.createdAt.$lte = new Date(endDate);
      }
    }

    // Get payment method distribution
    const paymentMethodPipeline = [
      { $match: { ...dateFilter, status: 'completed' } },
      {
        $group: {
          _id: '$paymentMethod',
          count: { $sum: 1 },
          totalAmount: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } }
        }
      }
    ];

    // Get payment status distribution
    const paymentStatusPipeline = [
      { $match: dateFilter },
      {
        $group: {
          _id: '$paymentStatus',
          count: { $sum: 1 },
          totalAmount: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } }
        }
      }
    ];

    // Execute aggregations
    const [paymentMethods, paymentStatuses] = await Promise.all([
      RideRequest.aggregate(paymentMethodPipeline),
      RideRequest.aggregate(paymentStatusPipeline)
    ]);

    // Get collection timeline
    const collectionTimeline = await RideRequest.aggregate([
      {
        $match: {
          ...dateFilter,
          status: 'completed',
          paymentStatus: 'collected'
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$paymentCollectedAt' },
            month: { $month: '$paymentCollectedAt' },
            day: { $dayOfMonth: '$paymentCollectedAt' }
          },
          collected: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    // Format payment method data
    const paymentMethodData = {};
    paymentMethods.forEach(item => {
      const method = item._id || 'cash';
      paymentMethodData[method] = {
        count: item.count,
        amount: item.totalAmount,
        percentage: 0 // Will calculate after
      };
    });

    // Calculate percentages
    const totalPayments = Object.values(paymentMethodData).reduce((sum, item) => sum + item.count, 0);
    Object.keys(paymentMethodData).forEach(method => {
      paymentMethodData[method].percentage = totalPayments > 0
        ? Math.round(paymentMethodData[method].count / totalPayments * 100)
        : 0;
    });

    // Format payment status data
    const paymentStatusData = {};
    paymentStatuses.forEach(item => {
      const status = item._id || 'pending';
      paymentStatusData[status] = {
        count: item.count,
        amount: item.totalAmount
      };
    });

    // Format collection timeline
    const timeline = collectionTimeline.map(item => ({
      date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`,
      collected: item.collected,
      count: item.count
    }));

    console.log(`✅ Payment analytics calculated`);

    res.json({
      success: true,
      data: {
        paymentMethods: paymentMethodData,
        paymentStatus: paymentStatusData,
        collectionTimeline: timeline,
        summary: {
          totalCollected: paymentStatusData.collected?.amount || 0,
          totalPending: paymentStatusData.pending?.amount || 0,
          collectionRate: totalPayments > 0
            ? Math.round((paymentStatusData.collected?.count || 0) / totalPayments * 100)
            : 0
        }
      }
    });

  } catch (error) {
    console.error('❌ Error getting payment analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting payment analytics',
      error: error.message
    });
  }
});

// @desc    Get top routes by revenue
// @route   GET /api/admin/financial/top-routes
// @access  Private (Admin only)
router.get('/top-routes', adminProtect, async (req, res) => {
  try {
    const { limit = 10, startDate, endDate } = req.query;

    console.log('🛣️ [Financial API] Getting top routes by revenue');

    // Build date filter
    const dateFilter = { status: 'completed' };
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) {
        dateFilter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        dateFilter.createdAt.$lte = new Date(endDate);
      }
    }

    // Aggregation pipeline
    const pipeline = [
      { $match: dateFilter },
      {
        $group: {
          _id: {
            pickup: '$pickupLocation.boothName',
            destination: '$destination'
          },
          totalRevenue: { $sum: { $ifNull: ['$customerFare', '$estimatedFare'] } },
          rideCount: { $sum: 1 },
          avgDistance: { $avg: '$distance' },
          avgFare: { $avg: { $ifNull: ['$customerFare', '$estimatedFare'] } }
        }
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: parseInt(limit) }
    ];

    const topRoutes = await RideRequest.aggregate(pipeline);

    // Format the data
    const formattedRoutes = topRoutes.map((route, index) => ({
      rank: index + 1,
      route: `${route._id.pickup || 'Unknown'} → ${route._id.destination || 'Unknown'}`,
      pickup: route._id.pickup || 'Unknown',
      destination: route._id.destination || 'Unknown',
      revenue: Math.round(route.totalRevenue),
      rides: route.rideCount,
      avgDistance: Math.round(route.avgDistance * 10) / 10,
      avgFare: Math.round(route.avgFare)
    }));

    console.log(`✅ Top ${formattedRoutes.length} routes calculated`);

    res.json({
      success: true,
      data: formattedRoutes
    });

  } catch (error) {
    console.error('❌ Error getting top routes:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting top routes',
      error: error.message
    });
  }
});

// @desc    Export financial report
// @route   GET /api/admin/financial/export
// @access  Private (Admin only)
router.get('/export', adminProtect, async (req, res) => {
  try {
    const { format = 'csv', startDate, endDate } = req.query;

    console.log('📥 [Financial API] Exporting financial report');

    // Build query filter
    const filter = {};
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.createdAt.$lte = new Date(endDate);
      }
    }

    // Get all rides
    const rides = await RideRequest.find(filter)
      .populate('userId', 'name mobileNo')
      .populate('driverId', 'fullName mobileNo vehicleNo')
      .sort({ createdAt: -1 });

    if (format === 'csv') {
      // Generate CSV
      let csv = 'Ride ID,Date,Time,Customer,Driver,Vehicle Type,Distance,Driver Fare,Customer Total,Platform Earning,Payment Status,Ride Status\n';

      rides.forEach(ride => {
        const date = new Date(ride.createdAt);
        const driverFare = ride.driverFare || ride.fare || 0;
        const customerTotal = ride.customerFare || ride.estimatedFare || 0;
        const platformEarning = ride.platformEarning != null
          ? ride.platformEarning
          : Math.max(0, customerTotal - driverFare);

        csv += `${ride.rideId || ride._id},${date.toLocaleDateString()},${date.toLocaleTimeString()},${ride.userId?.name || 'N/A'},${ride.driverId?.fullName || 'N/A'},${ride.vehicleType || 'N/A'},${ride.distance || 0},${driverFare},${customerTotal},${platformEarning},${ride.paymentStatus || 'pending'},${ride.status}\n`;
      });

      res.header('Content-Type', 'text/csv');
      res.header('Content-Disposition', `attachment; filename=financial-report-${new Date().toISOString().split('T')[0]}.csv`);
      res.send(csv);

    } else {
      // Return JSON format
      const reportData = rides.map(ride => {
        const driverFare = ride.driverFare || ride.fare || 0;
        const customerTotal = ride.customerFare || ride.estimatedFare || 0;
        const platformEarning = ride.platformEarning != null
          ? ride.platformEarning
          : Math.max(0, customerTotal - driverFare);
        return {
          rideId: ride.rideId || ride._id,
          date: ride.createdAt,
          customer: ride.userId?.name || 'N/A',
          driver: ride.driverId?.fullName || 'N/A',
          vehicleType: ride.vehicleType,
          distance: ride.distance,
          driverFare,
          customerTotal,
          platformEarning,
          paymentStatus: ride.paymentStatus,
          rideStatus: ride.status
        };
      });

      res.json({
        success: true,
        data: reportData,
        count: reportData.length,
        dateRange: { startDate, endDate }
      });
    }

  } catch (error) {
    console.error('❌ Error exporting financial report:', error);
    res.status(500).json({
      success: false,
      message: 'Error exporting financial report',
      error: error.message
    });
  }
});

module.exports = router;