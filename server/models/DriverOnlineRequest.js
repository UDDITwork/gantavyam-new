/**
 * DriverOnlineRequest Model
 * Manages driver requests to go online (requires admin approval)
 */
const mongoose = require('mongoose');

const DriverOnlineRequestSchema = new mongoose.Schema({
  // Driver reference
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Driver',
    required: true,
    index: true
  },

  // Cached driver info for quick display
  driverName: {
    type: String,
    required: true
  },
  driverPhone: {
    type: String,
    required: true
  },
  driverPhoto: {
    type: String
  },

  // Request details
  boothName: {
    type: String,
    required: true
  },
  vehicleType: {
    type: String,
    enum: ['bike', 'auto', 'car'],
    required: true
  },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    }
  },

  // Request status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'expired', 'cancelled'],
    default: 'pending',
    index: true
  },

  // Timestamps
  requestedAt: {
    type: Date,
    default: Date.now
  },
  processedAt: {
    type: Date
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },

  // Admin who processed the request
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  processedByName: {
    type: String
  },

  // Rejection reason (if rejected)
  rejectionReason: {
    type: String
  }
}, {
  timestamps: true
});

// TTL index for auto-cleanup of expired requests (MongoDB will delete after expiresAt)
DriverOnlineRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for efficient queries
DriverOnlineRequestSchema.index({ status: 1, requestedAt: -1 });
DriverOnlineRequestSchema.index({ driverId: 1, status: 1 });

// Geospatial index for location-based queries (if needed later)
DriverOnlineRequestSchema.index({ location: '2dsphere' });

/**
 * Static method to get pending requests count
 */
DriverOnlineRequestSchema.statics.getPendingCount = async function() {
  return this.countDocuments({ status: 'pending' });
};

/**
 * Static method to get pending requests for a specific booth
 */
DriverOnlineRequestSchema.statics.getPendingByBooth = async function(boothName) {
  return this.find({
    status: 'pending',
    boothName
  }).sort({ requestedAt: 1 });
};

/**
 * Static method to check if driver has pending request
 */
DriverOnlineRequestSchema.statics.hasPendingRequest = async function(driverId) {
  const request = await this.findOne({
    driverId,
    status: 'pending'
  });
  return !!request;
};

/**
 * Instance method to approve the request
 */
DriverOnlineRequestSchema.methods.approve = async function(adminId, adminName) {
  this.status = 'approved';
  this.processedAt = new Date();
  this.processedBy = adminId;
  this.processedByName = adminName;
  return this.save();
};

/**
 * Instance method to reject the request
 */
DriverOnlineRequestSchema.methods.reject = async function(adminId, adminName, reason = '') {
  this.status = 'rejected';
  this.processedAt = new Date();
  this.processedBy = adminId;
  this.processedByName = adminName;
  this.rejectionReason = reason;
  return this.save();
};

/**
 * Instance method to cancel the request (by driver)
 */
DriverOnlineRequestSchema.methods.cancel = async function() {
  this.status = 'cancelled';
  this.processedAt = new Date();
  return this.save();
};

/**
 * Pre-save middleware to set default expiry (10 minutes from creation)
 */
DriverOnlineRequestSchema.pre('save', function(next) {
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
  }
  next();
});

module.exports = mongoose.model('DriverOnlineRequest', DriverOnlineRequestSchema);
