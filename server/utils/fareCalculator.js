// utils/fareCalculator.js

const FareConfig = require('../models/FareConfig');

// Cache for config to avoid frequent DB calls
let cachedConfig = null;
let cacheExpiry = null;

const getConfig = async () => {
  if (cachedConfig && cacheExpiry && cacheExpiry > Date.now()) {
    return cachedConfig;
  }

  cachedConfig = await FareConfig.getActiveConfig();
  cacheExpiry = Date.now() + (5 * 60 * 1000); // Cache for 5 minutes
  return cachedConfig;
};

// Clear cache when needed
const clearConfigCache = () => {
  cachedConfig = null;
  cacheExpiry = null;
};

// Piecewise linear fare tables — hardcoded, not stored in DB
// Each entry: { maxKm, fn } — applies when distance <= maxKm
const FARE_TABLES = {
  auto: {
    user: [
      { maxKm: 1,        fn: (x) => 55 },                        // flat ₹55 minimum (< 1km)
      { maxKm: 2,        fn: (x) => 55  + 2  * (x - 1)  },      // ₹55–57
      { maxKm: 3,        fn: (x) => 57  + 11 * (x - 2)  },      // ₹57–68
      { maxKm: 5,        fn: (x) => 68  + 17 * (x - 3)  },      // ₹68–102
      { maxKm: 6,        fn: (x) => 102 + 23 * (x - 5)  },      // ₹102–125
      { maxKm: 7,        fn: (x) => 125 + 15 * (x - 6)  },      // ₹125–140
      { maxKm: 8,        fn: (x) => 140 + 10 * (x - 7)  },      // ₹140–150
      { maxKm: 9,        fn: (x) => 150 + 20 * (x - 8)  },      // ₹150–170
      { maxKm: 10,       fn: (x) => 170 + 20 * (x - 9)  },      // ₹170–190
      { maxKm: 11,       fn: (x) => 190 + 10 * (x - 10) },      // ₹190–200
      { maxKm: 15,       fn: (x) => 200 + 15 * (x - 11) },      // ₹200–260
      { maxKm: Infinity, fn: (x) => 215 + 15 * (x - 12) }       // > 15km
    ],
    driver: [
      { maxKm: 2,        fn: (x) => 50 },                        // flat ₹50
      { maxKm: 3,        fn: (x) => 50  + 10 * (x - 2)  },      // ₹50–60
      { maxKm: 5,        fn: (x) => 60  + 15 * (x - 3)  },      // ₹60–90
      { maxKm: 6,        fn: (x) => 90  + 20 * (x - 5)  },      // ₹90–110
      { maxKm: 7,        fn: (x) => 110 + 15 * (x - 6)  },      // ₹110–125
      { maxKm: 8,        fn: (x) => 125 + 10 * (x - 7)  },      // ₹125–135
      { maxKm: 9,        fn: (x) => 135 + 20 * (x - 8)  },      // ₹135–155
      { maxKm: 10,       fn: (x) => 155 + 15 * (x - 9)  },      // ₹155–170
      { maxKm: 11,       fn: (x) => 170 + 10 * (x - 10) },      // ₹170–180
      { maxKm: Infinity, fn: (x) => 180 + 15 * (x - 11) }       // > 11km
    ]
  },
  // Bike and Car formulas — pending (same structure, numbers TBD)
  bike: {
    user: [
      { maxKm: Infinity, fn: (x) => 52 } // Placeholder — use auto formula until provided
    ],
    driver: [
      { maxKm: Infinity, fn: (x) => 50 } // Placeholder
    ]
  },
  car: {
    user: [
      { maxKm: Infinity, fn: (x) => 52 } // Placeholder — use auto formula until provided
    ],
    driver: [
      { maxKm: Infinity, fn: (x) => 50 } // Placeholder
    ]
  }
};

/**
 * Evaluate a piecewise table for a given distance
 * @param {Array} table - Piecewise segments [{maxKm, fn}]
 * @param {number} x - Distance in km
 * @returns {number} Fare value
 */
const evalPiecewise = (table, x) => {
  for (const segment of table) {
    if (x <= segment.maxKm) {
      return segment.fn(x);
    }
  }
  // Fallback to last segment
  return table[table.length - 1].fn(x);
};

/**
 * Calculate distance between two points using Haversine formula
 * @param {number} lat1 - Latitude of first point
 * @param {number} lng1 - Longitude of first point
 * @param {number} lat2 - Latitude of second point
 * @param {number} lng2 - Longitude of second point
 * @returns {number} Distance in kilometers
 */
const calculateDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const toRad = (deg) => deg * (Math.PI / 180);

/**
 * Check if current time is in night charge period
 * @returns {boolean} Whether night charge applies
 */
const isNightTime = async () => {
  const config = await getConfig();
  const nightCharge = config.nightCharge;

  if (!nightCharge || !nightCharge.isActive) {
    console.warn('[NightCharge] DISABLED in DB config (nightCharge.isActive=false) — no after-hours charge will apply.');
    return false;
  }

  const now = new Date();
  // Always use IST (UTC+5:30) regardless of server timezone
  const currentHour = (now.getUTCHours() + 5 + (now.getUTCMinutes() >= 30 ? 1 : 0)) % 24;

  if (nightCharge.startHour <= nightCharge.endHour) {
    // Normal period (daytime band)
    return currentHour >= nightCharge.startHour && currentHour <= nightCharge.endHour;
  } else {
    // Overnight period (e.g., 20 to 8)
    return currentHour >= nightCharge.startHour || currentHour < nightCharge.endHour;
  }
};

/**
 * Calculate fare for a specific vehicle type using piecewise linear formula.
 * Customer fare and driver fare are independent equations — platform earns the spread.
 * No commission, no GST, no waiting charges, no base fare, no minimum fare.
 *
 * @param {string} vehicleType - Type of vehicle (bike, auto, car)
 * @param {number} distance - Distance in kilometers
 * @param {boolean} applySurge - Unused, kept for backward compat
 * @param {number} waitingTime - Unused, kept for backward compat
 * @returns {Object} Fare calculation details
 */
const calculateFare = async (vehicleType, distance, applySurge = true, waitingTime = 0) => {
  const table = FARE_TABLES[vehicleType];

  if (!table) {
    throw new Error(`Invalid vehicle type: ${vehicleType}`);
  }

  const safeDistance = Math.max(0.1, Number(distance) || 0.1);

  // Day fares from piecewise formulas
  const userDayFare = evalPiecewise(table.user, safeDistance);
  const driverDayFare = evalPiecewise(table.driver, safeDistance);

  // Cap: ensure customerFare >= driverFare so platform never loses (kicks in >21km for auto)
  const userDayCapped = Math.max(userDayFare, driverDayFare);

  const dbConfig = await getConfig();
  const isNight = await isNightTime();

  let customerTotalFare;
  let driverFare;
  let nightChargeUserAmount = 0;
  let nightChargeDriverAmount = 0;

  if (isNight && dbConfig.nightCharge && dbConfig.nightCharge.isActive) {
    const userPct = dbConfig.nightCharge.userPercentage ?? 30;
    const driverPct = dbConfig.nightCharge.driverPercentage ?? 25;
    console.log(`[NightCharge] Applied for ${vehicleType} ${safeDistance}km — user +${userPct}%, driver +${driverPct}%`);

    customerTotalFare = Math.round(userDayCapped * (1 + userPct / 100));
    driverFare = Math.round(driverDayFare * (1 + driverPct / 100));

    nightChargeUserAmount = customerTotalFare - Math.round(userDayCapped);
    nightChargeDriverAmount = driverFare - Math.round(driverDayFare);
  } else {
    customerTotalFare = Math.round(userDayCapped);
    driverFare = Math.round(driverDayFare);
  }

  const platformEarning = customerTotalFare - driverFare;

  const nightChargeUserPercentage = (isNight && dbConfig.nightCharge?.isActive)
    ? (dbConfig.nightCharge.userPercentage ?? 30) : 0;
  const nightChargeDriverPercentage = (isNight && dbConfig.nightCharge?.isActive)
    ? (dbConfig.nightCharge.driverPercentage ?? 25) : 0;

  return {
    vehicleType,
    distance: parseFloat(distance.toFixed(2)),
    customerTotalFare,   // What customer pays
    driverFare,          // What driver earns
    platformEarning,     // customerTotalFare - driverFare
    isNightCharge: isNight,
    nightChargeUserAmount,
    nightChargeDriverAmount,
    nightChargeUserPercentage,    // Actual % applied to user (0 if day)
    nightChargeDriverPercentage,  // Actual % applied to driver (0 if day)
    // Kept at 0 for backward compatibility with old ride records
    commissionAmount: 0,
    gstAmount: 0,
    nightChargeAmount: nightChargeUserAmount, // legacy field
    // Legacy fields kept for backward compat
    totalFare: driverFare,
    baseFare: 0,
    surgeFactor: 1.0,
    breakdown: {
      driverFare,
      customerFare: customerTotalFare,
      platformEarning,
      isNightCharge: isNight,
      nightChargeUserAmount,
      nightChargeDriverAmount,
      // Kept at 0 for backward compat
      commissionAmount: 0,
      gstAmount: 0,
      surgeAmount: 0
    }
  };
};

/**
 * Calculate fare estimates for all vehicle types
 * @param {number} pickupLat - Pickup latitude
 * @param {number} pickupLng - Pickup longitude
 * @param {number} dropLat - Drop latitude
 * @param {number} dropLng - Drop longitude
 * @returns {Object} Fare estimates for all vehicle types
 */
const calculateFareEstimates = async (pickupLat, pickupLng, dropLat, dropLng, distanceOverride) => {
  const distance = (distanceOverride != null && distanceOverride > 0)
    ? distanceOverride
    : calculateDistance(pickupLat, pickupLng, dropLat, dropLng);

  const estimates = {};

  // Calculate for each vehicle type
  for (const vehicleType of Object.keys(FARE_TABLES)) {
    estimates[vehicleType] = await calculateFare(vehicleType, distance, true, 0);
  }

  return {
    distance: parseFloat(distance.toFixed(2)),
    estimates,
    surgeFactor: 1.0, // Surge pricing removed
    timestamp: new Date().toISOString()
  };
};

/**
 * Log fare calculation details
 * @param {string} rideId - Unique ride identifier
 * @param {Object} fareDetails - Fare calculation details
 */
const logFareCalculation = (rideId, fareDetails) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] FARE-CALC: ${rideId} |`, JSON.stringify(fareDetails));
};

module.exports = {
  calculateDistance,
  calculateFare,
  calculateFareEstimates,
  logFareCalculation,
  clearConfigCache,
  getConfig,
  FARE_TABLES
};
