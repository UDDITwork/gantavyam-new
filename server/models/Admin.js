// models/Admin.js
const mongoose = require('../db');
const bcrypt = require('bcryptjs');

const AdminSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a name']
  },
  email: {
    type: String,
    required: [true, 'Please add an email'],
    unique: true,
    match: [
      /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,})+$/,
      'Please add a valid email'
    ]
  },
  role: {
    type: String,
    enum: ['admin', 'super-admin', 'executive-manager', 'fleet-manager'],
    default: 'admin'
  },
  // Permissions array for granular access control
  permissions: [{
    type: String,
    enum: [
      // Driver permissions
      'drivers:view', 'drivers:create', 'drivers:edit', 'drivers:delete', 'drivers:verify',
      // Ride permissions
      'rides:view', 'rides:manage', 'rides:manual_booking',
      // User permissions
      'users:view', 'users:create', 'users:edit',
      // Queue permissions
      'queue:view', 'queue:manage',
      // Financial permissions (restricted)
      'financial:view', 'financial:export',
      // Fare permissions
      'fare:view', 'fare:edit',
      // Settings permissions
      'settings:view', 'settings:edit',
      // Admin permissions
      'admins:manage'
    ]
  }],
  password: {
    type: String,
    required: [true, 'Please add a password'],
    minlength: 6,
    select: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  // Executives ("executive-manager") belong to one pickup point (pod): 'HK' = Hauz Khas, 'PC' = Patel Chowk
  // (see config/pickupPods.js). They only see and manage that pod. Empty for every other role.
  assignedPickupLocation: {
    type: String,
    default: null
  },
  lastLogin: Date,
  resetPasswordToken: String,
  resetPasswordExpire: Date,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// What each role may do. The server and the admin panel both follow these lists.
const FULL_ACCESS = [
  'drivers:view', 'drivers:create', 'drivers:edit', 'drivers:delete', 'drivers:verify',
  'rides:view', 'rides:manage', 'rides:manual_booking',
  'users:view', 'users:create', 'users:edit',
  'queue:view', 'queue:manage',
  'financial:view', 'financial:export',
  'fare:view', 'fare:edit',
  'settings:view', 'settings:edit',
  'admins:manage'
];

const ROLE_PERMISSIONS = {
  'super-admin': FULL_ACCESS,
  // Regular admin has full access (same as super-admin)
  admin: FULL_ACCESS,

  // Executive (sub-admin of one pickup point): exactly the four operations features - Fleet Manager, Queue
  // Management, Register Driver and Manual Booking. Nothing else: no users list, financials, fares, settings,
  // driver edit/delete/verify or other admins. The routes additionally limit everything to the executive's own pod.
  'executive-manager': [
    'drivers:view',           // drivers of the own pod (Fleet Manager, Queue Management, Manual Booking)
    'drivers:create',         // Register Driver
    'rides:view',             // Fleet Manager
    'rides:manage',
    'rides:manual_booking',   // Manual Booking
    'queue:view',             // Queue Management
    'queue:manage'
  ],

  'fleet-manager': [
    'rides:view',             // Access Fleet Manager tab and view rides
    'drivers:view',           // View driver details in Fleet Manager
    'drivers:create',         // Register/onboard new drivers
    'queue:view'              // View queue numbers in Fleet Manager
  ]
};

// An unknown role gets nothing
const permissionsForRole = (role) => [...(ROLE_PERMISSIONS[role] || [])];

// Auto-assign permissions based on role (before save)
AdminSchema.pre('save', async function(next) {
  // Assign permissions based on role if role is modified or document is new
  if (this.isModified('role') || this.isNew) {
    this.permissions = permissionsForRole(this.role);
  }

  // Only executives belong to a pod
  if (this.role !== 'executive-manager' && this.assignedPickupLocation) {
    this.assignedPickupLocation = null;
  }

  // Encrypt password using bcrypt
  if (this.isModified('password')) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
  }

  next();
});

// Match user entered password to hashed password in database
AdminSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

AdminSchema.statics.createDefaultAdmin = async function() {
  const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@admin.com';
  const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD;

  if (!adminPassword) {
    console.log('DEFAULT_ADMIN_PASSWORD not set in environment variables. Skipping default admin creation.');
    return;
  }

  const existing = await this.findOne({ email: adminEmail });
  if (!existing) {
    const admin = new this({
      name: 'Admin',
      email: adminEmail,
      password: adminPassword,
      role: 'admin'
    });
    await admin.save();
    console.log(`Default admin created: ${adminEmail}`);
  } else {
    // Update password from environment variable
    existing.password = adminPassword;
    await existing.save();
    console.log('Default admin password updated from environment variable.');
  }
};

// Update existing admin permissions to match current role definitions
AdminSchema.statics.updateAdminPermissions = async function() {
  try {
    const admins = await this.find({});
    let updatedCount = 0;

    for (const admin of admins) {
      const expectedPermissions = permissionsForRole(admin.role);

      // Check if permissions need updating
      const currentPerms = JSON.stringify([...(admin.permissions || [])].sort());
      const expectedPerms = JSON.stringify([...expectedPermissions].sort());

      if (currentPerms !== expectedPerms) {
        admin.permissions = expectedPermissions;
        await admin.save({ validateBeforeSave: false }); // Skip validation to avoid password re-hash
        updatedCount++;
        console.log(`✅ Updated permissions for admin: ${admin.email} (${admin.role})`);
      }
    }

    if (updatedCount > 0) {
      console.log(`✅ Updated ${updatedCount} admin(s) with new permissions`);
    } else {
      console.log('✅ All admin permissions are up to date');
    }
  } catch (error) {
    console.error('❌ Error updating admin permissions:', error);
  }
};

AdminSchema.statics.permissionsForRole = permissionsForRole;

// Finds an admin by e-mail: as typed first, then ignoring letter case (e-mails are stored as typed at creation)
AdminSchema.statics.findByEmail = async function(email) {
  const typed = String(email || '').trim();
  if (!typed) return null;
  const exact = await this.findOne({ email: typed }).select('+password');
  if (exact) return exact;
  const lower = typed.toLowerCase();
  return lower !== typed ? this.findOne({ email: lower }).select('+password') : null;
};

module.exports = mongoose.model('Admin', AdminSchema);