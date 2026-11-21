// routes/fareEstimation.js
const express = require('express');
const router = express.Router();
const { calculateFareEstimates, calculateDistance } = require('../utils/fareCalculator');
// Note: getDynamicPricingFactor removed - dynamic pricing disabled
const { logRideEvent } = require('../utils/otpUtils');
const MetroStation = require('../models/MetroStation');
const Driver = require('../models/Driver');
const RideRequest = require('../models/RideRequest');

// Get fare estimates for a ride
router.post('/estimate', async (req, res) => {
  try {
    const { pickupLat, pickupLng, dropLat, dropLng, pickupStation, detailed, distance } = req.body;

    console.log('\n=== FARE ESTIMATION REQUEST ===');
    console.log('Pickup:', pickupLat, pickupLng);
    console.log('Drop:', dropLat, dropLng);
    console.log('Pickup Station:', pickupStation);
    console.log('Detailed:', detailed || false);

    // Validate input
    if (!pickupLat || !pickupLng || !dropLat || !dropLng) {
      return res.status(400).json({
        success: false,
        message: 'Missing required coordinates'
      });
    }

    // Calculate fare estimates
    const fareEstimates = await calculateFareEstimates(
      pickupLat, pickupLng, dropLat, dropLng,
      distance != null ? parseFloat(distance) : undefined
    );

    // Dynamic pricing DISABLED - use original fare estimates directly
    // Surge pricing (time-based) is still applied in calculateFare()
    const finalEstimates = {};
    
    Object.keys(fareEstimates.estimates).forEach(vehicleType => {
      const estimate = fareEstimates.estimates[vehicleType];

      // For customer view (no breakdown unless detailed is requested)
      if (!detailed) {
        finalEstimates[vehicleType] = {
          totalFare: estimate.customerTotalFare, // Customer sees only total
          customerTotalFare: estimate.customerTotalFare,
          vehicleType: estimate.vehicleType,
          distance: estimate.distance,
          surgeFactor: estimate.surgeFactor,
          isNightCharge: estimate.isNightCharge,
          nightChargeUserAmount: estimate.nightChargeUserAmount,
          nightChargeDriverAmount: estimate.nightChargeDriverAmount,
          nightChargeUserPercentage: estimate.nightChargeUserPercentage,
          nightChargeDriverPercentage: estimate.nightChargeDriverPercentage
        };
      } else {
        // For admin view (full breakdown)
        finalEstimates[vehicleType] = {
          ...estimate,
          platformEarning: estimate.platformEarning,
          nightChargeUserAmount: estimate.nightChargeUserAmount,
          nightChargeDriverAmount: estimate.nightChargeDriverAmount,
          breakdown: {
            ...estimate.breakdown,
            customerTotal: estimate.customerTotalFare,
            driverTotal: estimate.driverFare,
            platformEarning: estimate.platformEarning
          }
        };
      }
    });

    const response = {
      success: true,
      distance: fareEstimates.distance,
      estimates: finalEstimates,
      surgeFactor: fareEstimates.surgeFactor,
      timestamp: fareEstimates.timestamp,
      detailed: detailed || false
    };

    // Log fare estimation
    logRideEvent('FARE-ESTIMATE', 'fare_calculated', {
      pickupStation,
      distance: fareEstimates.distance,
      surgeFactor: fareEstimates.surgeFactor,
      detailed: detailed || false,
      estimates: Object.keys(finalEstimates).map(type => ({
        type,
        customerFare: finalEstimates[type].totalFare,
        driverFare: detailed ? finalEstimates[type].driverFare : undefined
      }))
    });

    console.log('✅ Fare estimation completed');
    res.json(response);

  } catch (error) {
    console.error('❌ Error calculating fare estimates:', error);
    res.status(500).json({
      success: false,
      message: 'Error calculating fare estimates',
      error: error.message
    });
  }
});

// Get available drivers by vehicle type and station
router.get('/drivers-availability', async (req, res) => {
  try {
    const { vehicleType, metroStation } = req.query;
    
    console.log('\n=== DRIVER AVAILABILITY REQUEST ===');
    console.log('Vehicle Type:', vehicleType);
    console.log('Metro Station:', metroStation);
    
    let query = { isOnline: true };
    
    if (vehicleType) {
      query.vehicleType = vehicleType;
    }
    
    if (metroStation) {
      query.currentMetroBooth = metroStation;
    }
    
    const drivers = await Driver.find(query).select('vehicleType currentMetroBooth rating totalRides');
    
    // Group by vehicle type
    const availability = {
      bike: [],
      auto: [],
      car: []
    };
    
    drivers.forEach(driver => {
      availability[driver.vehicleType].push({
        id: driver._id,
        metroStation: driver.currentMetroBooth,
        rating: driver.rating,
        totalRides: driver.totalRides
      });
    });
    
    const summary = {
      bike: availability.bike.length,
      auto: availability.auto.length,
      car: availability.car.length,
      total: drivers.length
    };
    
    console.log('📊 Driver availability:', summary);
    
    res.json({
      success: true,
      availability,
      summary,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting driver availability:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting driver availability',
      error: error.message
    });
  }
});

// Get metro stations with driver counts
router.get('/stations', async (req, res) => {
  try {
    console.log('\n=== METRO STATIONS REQUEST ===');
    
    const stations = await MetroStation.find({ isActive: true })
      .select('name line lat lng onlineDrivers')
      .sort({ name: 1 });
    
    // Get current driver counts
    const stationsWithDrivers = await Promise.all(
      stations.map(async (station) => {
        const driverCounts = await Driver.aggregate([
          {
            $match: {
              isOnline: true,
              currentMetroBooth: station.name
            }
          },
          {
            $group: {
              _id: '$vehicleType',
              count: { $sum: 1 }
            }
          }
        ]);
        
        const counts = { bike: 0, auto: 0, car: 0 };
        driverCounts.forEach(item => {
          counts[item._id] = item.count;
        });
        
        return {
          id: station.id,
          name: station.name,
          line: station.line,
          lat: station.lat,
          lng: station.lng,
          driverCounts: counts,
          totalDrivers: counts.bike + counts.auto + counts.car
        };
      })
    );
    
    console.log(`📍 Returning ${stationsWithDrivers.length} metro stations`);
    
    res.json({
      success: true,
      stations: stationsWithDrivers,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting metro stations:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting metro stations',
      error: error.message
    });
  }
});

module.exports = router;