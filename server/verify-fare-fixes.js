/**
 * Verification Script for Fare Calculation Fixes
 *
 * This script verifies that the platform earnings and driver earnings are correctly calculated
 * Run this after deploying the fixes to ensure everything is working correctly
 */

const mongoose = require('mongoose');

async function verifyFareFixes() {
  try {
    // Connect to MongoDB
    const mongoUrl = process.env.MONGO_URL;
    if (!mongoUrl) {
      throw new Error('MONGO_URL environment variable is not set');
    }
    await mongoose.connect(mongoUrl);
    console.log('✅ Connected to MongoDB\n');

    const RideRequest = mongoose.model('RideRequest');

    // Query 1: Find rides with discrepancies (missing surge in platform earnings)
    console.log('=== QUERY 1: Finding Rides with Platform Earnings Discrepancies ===\n');

    const discrepancies = await RideRequest.aggregate([
      {
        $match: {
          status: { $in: ['completed', 'cancelled'] },
          customerFare: { $exists: true },
          driverFare: { $exists: true },
          createdAt: { $gte: new Date('2024-01-01') }
        }
      },
      {
        $project: {
          rideNumber: 1,
          distance: 1,
          vehicleType: 1,
          status: 1,
          customerFare: 1,
          driverFare: 1,
          commissionAmount: 1,
          gstAmount: 1,
          nightChargeAmount: 1,

          // Calculate what platform SHOULD get
          expectedPlatform: {
            $subtract: ["$customerFare", "$driverFare"]
          },

          // Calculate what's currently recorded in breakdown
          recordedPlatform: {
            $add: [
              { $ifNull: ["$commissionAmount", 0] },
              { $ifNull: ["$gstAmount", 0] },
              { $ifNull: ["$nightChargeAmount", 0] }
            ]
          }
        }
      },
      {
        $addFields: {
          // Find the difference (this is the missing surge)
          missingSurge: {
            $subtract: ["$expectedPlatform", "$recordedPlatform"]
          }
        }
      },
      {
        $match: {
          missingSurge: { $gt: 0.5 }  // Show rides with missing money > ₹0.5
        }
      },
      {
        $sort: { createdAt: -1 }
      },
      {
        $limit: 10  // Show first 10 examples
      }
    ]);

    if (discrepancies.length > 0) {
      console.log(`⚠️  Found ${discrepancies.length} rides with platform earnings discrepancies:\n`);
      discrepancies.forEach((ride, index) => {
        console.log(`${index + 1}. Ride: ${ride.rideNumber || 'N/A'}`);
        console.log(`   Distance: ${ride.distance} km, Vehicle: ${ride.vehicleType}`);
        console.log(`   Customer Paid: ₹${ride.customerFare}`);
        console.log(`   Driver Earned: ₹${ride.driverFare}`);
        console.log(`   Expected Platform: ₹${ride.expectedPlatform}`);
        console.log(`   Recorded Platform: ₹${ride.recordedPlatform}`);
        console.log(`   Missing Surge: ₹${ride.missingSurge.toFixed(2)} ❌\n`);
      });
    } else {
      console.log('✅ No discrepancies found! All rides are balanced.\n');
    }

    // Query 2: Verify recent rides are correctly calculated
    console.log('\n=== QUERY 2: Verifying Recent Rides ===\n');

    const recentRides = await RideRequest.find({
      status: 'completed',
      customerFare: { $exists: true },
      driverFare: { $exists: true }
    })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();

    console.log(`Checking last 5 completed rides:\n`);

    recentRides.forEach((ride, index) => {
      const expectedPlatform = ride.customerFare - ride.driverFare;
      const recordedPlatform = (ride.commissionAmount || 0) + (ride.gstAmount || 0) + (ride.nightChargeAmount || 0);
      const isBalanced = Math.abs(expectedPlatform - recordedPlatform) < 0.1;

      console.log(`${index + 1}. Ride: ${ride.rideNumber || ride._id}`);
      console.log(`   Customer: ₹${ride.customerFare}, Driver: ₹${ride.driverFare}`);
      console.log(`   Platform should get: ₹${expectedPlatform}`);
      console.log(`   Platform recorded: ₹${recordedPlatform}`);
      console.log(`   ${isBalanced ? '✅ Balanced' : '❌ Imbalanced'}\n`);
    });

    // Query 3: Summary statistics
    console.log('\n=== QUERY 3: Overall Statistics ===\n');

    const stats = await RideRequest.aggregate([
      {
        $match: {
          status: 'completed',
          customerFare: { $exists: true },
          driverFare: { $exists: true },
          createdAt: { $gte: new Date('2024-01-01') }
        }
      },
      {
        $group: {
          _id: null,
          totalRides: { $sum: 1 },
          totalCustomerRevenue: { $sum: "$customerFare" },
          totalDriverEarnings: { $sum: "$driverFare" },
          totalCommission: { $sum: "$commissionAmount" },
          totalGST: { $sum: "$gstAmount" },
        }
      },
      {
        $project: {
          _id: 0,
          totalRides: 1,
          totalCustomerRevenue: 1,
          totalDriverEarnings: 1,
          calculatedPlatformRevenue: {
            $subtract: ["$totalCustomerRevenue", "$totalDriverEarnings"]
          },
          recordedPlatformRevenue: {
            $add: ["$totalCommission", "$totalGST"]
          }
        }
      }
    ]);

    if (stats.length > 0) {
      const stat = stats[0];
      console.log(`Total Completed Rides: ${stat.totalRides}`);
      console.log(`Total Customer Payments: ₹${stat.totalCustomerRevenue.toFixed(2)}`);
      console.log(`Total Driver Earnings: ₹${stat.totalDriverEarnings.toFixed(2)}`);
      console.log(`Calculated Platform Revenue: ₹${stat.calculatedPlatformRevenue.toFixed(2)}`);
      console.log(`Recorded Platform Revenue: ₹${stat.recordedPlatformRevenue.toFixed(2)}`);

      const discrepancy = stat.calculatedPlatformRevenue - stat.recordedPlatformRevenue;
      console.log(`\nTotal Missing Surge Amount: ₹${discrepancy.toFixed(2)}`);

      if (discrepancy > 1) {
        console.log(`⚠️  This is the total amount of surge revenue not being recorded in platform earnings!`);
      } else {
        console.log(`✅ Platform earnings are correctly recorded!`);
      }
    }

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run the verification
console.log('🔍 Starting Fare Fixes Verification...\n');
verifyFareFixes();
