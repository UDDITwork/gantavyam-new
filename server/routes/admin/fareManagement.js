const express = require('express');
const router = express.Router();
const FareConfig = require('../../models/FareConfig');
const { adminProtect } = require('../../middleware/auth');
const { checkPermission, PERMISSIONS } = require('../../middleware/permissions');
const { calculateFare, clearConfigCache, FARE_TABLES } = require('../../utils/fareCalculator');

// Get current fare configuration (view permission required)
router.get('/fare-config', adminProtect, checkPermission(PERMISSIONS.FARE_VIEW), async (req, res) => {
  try {
    const config = await FareConfig.getActiveConfig();

    res.json({
      success: true,
      config,
      fareFormulas: FARE_TABLES // Also return the hardcoded formulas for display
    });
  } catch (error) {
    console.error('Error fetching fare config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch fare configuration',
      error: error.message
    });
  }
});

// NOTE: Vehicle pricing (PUT /fare-config/vehicle/:type and PUT /fare-config/vehicles)
// has been REMOVED. Fare formulas are now hardcoded piecewise functions in fareCalculator.js.
// Only night charge settings are configurable via the database.

// Update night charge settings (edit permission required)
// Accepts: isActive, startHour, endHour, userPercentage, driverPercentage
router.put('/fare-config/night-charge', adminProtect, checkPermission(PERMISSIONS.FARE_EDIT), async (req, res) => {
  try {
    const { isActive, startHour, endHour, userPercentage, driverPercentage } = req.body;

    // Validate hours if provided
    if (startHour !== undefined && (startHour < 0 || startHour > 23)) {
      return res.status(400).json({
        success: false,
        message: 'Start hour must be between 0 and 23'
      });
    }

    if (endHour !== undefined && (endHour < 0 || endHour > 23)) {
      return res.status(400).json({
        success: false,
        message: 'End hour must be between 0 and 23'
      });
    }

    // Validate percentages if provided
    if (userPercentage !== undefined && (userPercentage < 0 || userPercentage > 100)) {
      return res.status(400).json({
        success: false,
        message: 'User night percentage must be between 0 and 100'
      });
    }

    if (driverPercentage !== undefined && (driverPercentage < 0 || driverPercentage > 100)) {
      return res.status(400).json({
        success: false,
        message: 'Driver night percentage must be between 0 and 100'
      });
    }

    // Get current config
    const currentConfig = await FareConfig.getActiveConfig();

    // Build updated night charge config
    const updatedNightCharge = {
      isActive: isActive !== undefined ? isActive : (currentConfig.nightCharge?.isActive ?? true),
      startHour: startHour !== undefined ? startHour : (currentConfig.nightCharge?.startHour ?? 20),
      endHour: endHour !== undefined ? endHour : (currentConfig.nightCharge?.endHour ?? 8),
      userPercentage: userPercentage !== undefined ? userPercentage : (currentConfig.nightCharge?.userPercentage ?? 30),
      driverPercentage: driverPercentage !== undefined ? driverPercentage : (currentConfig.nightCharge?.driverPercentage ?? 25)
    };

    // Create new config
    const newConfig = {
      nightCharge: updatedNightCharge,
      updatedBy: req.admin._id,
      updatedByName: req.admin.name,
      notes: 'Updated night charge settings',
      isActive: true
    };

    // Deactivate current config
    await FareConfig.updateOne(
      { _id: currentConfig._id },
      { isActive: false }
    );

    // Create new config
    const savedConfig = await FareConfig.create(newConfig);

    // Clear fare calculator cache so new config takes effect immediately
    clearConfigCache();

    res.json({
      success: true,
      message: 'Night charge settings updated successfully',
      config: savedConfig
    });
  } catch (error) {
    console.error('Error updating night charge settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update night charge settings',
      error: error.message
    });
  }
});

// Get fare config history (view permission required)
router.get('/fare-config/history', adminProtect, async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const history = await FareConfig.find()
      .sort('-createdAt')
      .skip(skip)
      .limit(parseInt(limit))
      .populate('updatedBy', 'name email');

    const total = await FareConfig.countDocuments();

    res.json({
      success: true,
      history,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching fare history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch fare history',
      error: error.message
    });
  }
});

// Simulate fare calculation using actual fareCalculator (view permission required)
router.post('/fare-config/simulate', adminProtect, async (req, res) => {
  try {
    const {
      vehicleType,
      distance,
      waitingTime = 0
    } = req.body;

    if (!vehicleType || !distance) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle type and distance are required'
      });
    }

    if (!['bike', 'auto', 'car'].includes(vehicleType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid vehicle type'
      });
    }

    // Use the actual calculateFare function (same logic as real bookings)
    const fareResult = await calculateFare(vehicleType, distance, true, waitingTime);

    res.json({
      success: true,
      simulation: {
        vehicleType,
        distance,
        isNightCharge: fareResult.isNightCharge,
        nightChargeUserAmount: fareResult.nightChargeUserAmount,
        nightChargeDriverAmount: fareResult.nightChargeDriverAmount,
        nightChargeUserPercentage: fareResult.nightChargeUserPercentage,
        nightChargeDriverPercentage: fareResult.nightChargeDriverPercentage,
        driverFare: fareResult.driverFare,
        customerTotalFare: fareResult.customerTotalFare,
        platformEarning: fareResult.platformEarning,
        totalFare: fareResult.customerTotalFare,
        // Kept at 0 for backward compat
        commissionAmount: 0,
        gstAmount: 0,
        breakdown: fareResult.breakdown
      }
    });
  } catch (error) {
    console.error('Error simulating fare:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to simulate fare',
      error: error.message
    });
  }
});

// Restore a previous config (edit permission required)
router.post('/fare-config/restore/:configId', adminProtect, checkPermission(PERMISSIONS.FARE_EDIT), async (req, res) => {
  try {
    const { configId } = req.params;

    // Find the config to restore
    const configToRestore = await FareConfig.findById(configId);
    if (!configToRestore) {
      return res.status(404).json({
        success: false,
        message: 'Configuration not found'
      });
    }

    // Deactivate all current configs
    await FareConfig.updateMany(
      { isActive: true },
      { isActive: false }
    );

    // Create new config based on the one to restore
    const newConfig = {
      nightCharge: configToRestore.nightCharge,
      updatedBy: req.admin._id,
      updatedByName: req.admin.name,
      notes: `Restored from version ${configToRestore.version}`,
      isActive: true
    };

    const savedConfig = await FareConfig.create(newConfig);

    // Clear fare calculator cache so restored config takes effect immediately
    clearConfigCache();

    res.json({
      success: true,
      message: 'Configuration restored successfully',
      config: savedConfig
    });
  } catch (error) {
    console.error('Error restoring config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to restore configuration',
      error: error.message
    });
  }
});

module.exports = router;
