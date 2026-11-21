const mongoose = require('../db');
require('dotenv').config();

const Admin = require('../models/Admin');

async function updateFleetManagerPermissions() {
  try {
    await mongoose.connect(process.env.MONGO_URL);
    console.log('Connected to MongoDB');

    // Find all fleet-manager accounts and update permissions
    const result = await Admin.updateMany(
      { role: 'fleet-manager' },
      {
        $set: {
          permissions: [
            'rides:view',
            'drivers:view',
            'drivers:create',
            'queue:view'
          ]
        }
      }
    );

    console.log(`✅ Updated ${result.modifiedCount} fleet-manager account(s)`);

    // Verify the update
    const fleetManagers = await Admin.find({ role: 'fleet-manager' });
    fleetManagers.forEach(fm => {
      console.log(`Fleet Manager: ${fm.email}`);
      console.log(`Permissions: ${fm.permissions.join(', ')}`);
    });

    await mongoose.connection.close();
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

updateFleetManagerPermissions();
