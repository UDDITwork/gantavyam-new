// scripts/updateExecutiveManager.js
// Script to update executive-manager permissions

const mongoose = require('../db');
const path = require('path');

// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const Admin = require('../models/Admin');

const updateExecutiveManager = async () => {
  try {
    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URL);
    console.log('✅ Connected to MongoDB\n');

    // Find executive-manager account
    const em = await Admin.findOne({ role: 'executive-manager' });

    if (!em) {
      console.log('⚠️ No executive-manager account found.');
      process.exit(0);
    }

    console.log(`🔍 Found executive-manager: ${em.email}\n`);
    console.log(`📝 Current permissions (${em.permissions.length}):`, em.permissions);

    // Updated permissions for executive-manager (limited access)
    const limitedPermissions = [
      'drivers:view',           // Can view drivers only
      'rides:view',             // Can view rides
      'rides:manage',           // Can manage ride status
      'rides:manual_booking',   // Can create manual bookings
      'queue:view',             // Can view queue
      'queue:manage'            // Can manage queue
    ];

    console.log(`\n🔄 Updating to new permissions (${limitedPermissions.length}):`, limitedPermissions);

    em.permissions = limitedPermissions;
    await em.save({ validateBeforeSave: false });

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Executive-manager permissions updated successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('📋 What executive-manager can do:');
    console.log('   ✅ View all drivers (no create/edit/delete/verify)');
    console.log('   ✅ View and manage rides');
    console.log('   ✅ Create manual bookings');
    console.log('   ✅ View and manage queue\n');

    console.log('🚫 What executive-manager CANNOT do:');
    console.log('   ❌ View/manage users');
    console.log('   ❌ Add/edit/delete/verify drivers');
    console.log('   ❌ View financial reports/dashboard');
    console.log('   ❌ Access fare management');
    console.log('   ❌ Access settings');
    console.log('   ❌ Manage admins');
    console.log('   ❌ Export financial data\n');

    console.log('💡 Executive-manager must logout and login again to see changes.\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error updating executive-manager:', error);
    process.exit(1);
  }
};

// Run the script
updateExecutiveManager();
