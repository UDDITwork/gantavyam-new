const mongoose = require('../db');
const dotenv = require('dotenv');
const path = require('path');
const Admin = require('../models/Admin');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const createFleetManager = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URL);
    console.log('📊 Connected to MongoDB');

    // Fleet manager credentials
    const fleetManagerEmail = process.env.FLEET_MANAGER_EMAIL || 'fleetmanager@admin.com';
    const fleetManagerPassword = process.env.FLEET_MANAGER_PASSWORD || 'FleetManager123!';
    const fleetManagerName = process.env.FLEET_MANAGER_NAME || 'Fleet Manager';

    // Check if fleet manager already exists
    const existing = await Admin.findOne({ email: fleetManagerEmail });

    if (existing) {
      console.log('⚠️  Fleet manager account already exists');
      console.log(`📧 Email: ${existing.email}`);
      console.log(`👤 Name: ${existing.name}`);
      console.log(`🔑 Role: ${existing.role}`);
      console.log(`📋 Permissions:`, existing.permissions);

      // Update role and permissions if needed
      if (existing.role !== 'fleet-manager') {
        console.log('🔄 Updating role to fleet-manager...');
        existing.role = 'fleet-manager';
        await existing.save(); // Triggers pre-save hook to assign permissions
        console.log('✅ Role updated successfully!');
      }

      console.log('💡 To update password, delete the account and re-run this script');
    } else {
      // Create new fleet manager account
      console.log('🆕 Creating new fleet manager account...');

      const fleetManager = new Admin({
        name: fleetManagerName,
        email: fleetManagerEmail,
        password: fleetManagerPassword,
        role: 'fleet-manager',
        isActive: true
      });

      await fleetManager.save(); // Pre-save hook will hash password and assign permissions

      console.log('✅ Fleet manager account created successfully!');
      console.log('');
      console.log('📋 Account Details:');
      console.log(`   👤 Name: ${fleetManager.name}`);
      console.log(`   📧 Email: ${fleetManager.email}`);
      console.log(`   🔑 Password: ${fleetManagerPassword}`);
      console.log(`   🎭 Role: ${fleetManager.role}`);
      console.log(`   📋 Permissions:`, fleetManager.permissions);
      console.log('');
      console.log('🔐 Login at: /admin');
      console.log('');
    }

    console.log('');
    console.log('📋 What fleet-manager can do:');
    console.log('   ✅ View ONLY Fleet Manager tab (accepted rides in real-time)');
    console.log('   ✅ View passenger details (name, phone)');
    console.log('   ✅ View driver details (name, phone, vehicle)');
    console.log('   ✅ View Start OTP and End OTP');
    console.log('   ✅ View queue numbers, booking IDs, locations');
    console.log('   ✅ Search and filter rides');
    console.log('   ✅ Real-time socket updates');
    console.log('');
    console.log('🚫 What fleet-manager CANNOT do:');
    console.log('   ❌ View Dashboard (no financial:view)');
    console.log('   ❌ View Ride Management tab (hidden for this role)');
    console.log('   ❌ Create Manual Bookings (no rides:manual_booking)');
    console.log('   ❌ Manage Rides (no rides:manage)');
    console.log('   ❌ View Queue Management tab (hidden for this role)');
    console.log('   ❌ Add/Edit/Delete Drivers (no drivers:create/edit/delete)');
    console.log('   ❌ View Users (no users:view)');
    console.log('   ❌ Access Settings, Fare Management, Financial Reports, etc.');

    await mongoose.connection.close();
    console.log('');
    console.log('✅ Script completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating fleet manager:', error);
    process.exit(1);
  }
};

// Run the script
createFleetManager();
