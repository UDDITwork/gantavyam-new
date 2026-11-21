/**
 * DriverOfflineRequest Model
 * Manages driver requests to go offline (requires admin approval)
 * Part of Admin-Only Queue Management System
 */
const mongoose = require('../db');

const DriverOfflineRequestSchema = new mongoose.Schema({
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

  // Request details
  boothName: {
    type: String
  },
  queuePosition: {
    type: Number
  },
  reason: {
    type: String,
    default: 'Driver requested to go offline'
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
DriverOfflineRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Compound index for efficient queries
DriverOfflineRequestSchema.index({ status: 1, requestedAt: -1 });
DriverOfflineRequestSchema.index({ driverId: 1, status: 1 });

/**
 * Static method to get pending requests count
 */
DriverOfflineRequestSchema.statics.getPendingCount = async function() {
  return this.countDocuments({ status: 'pending' });
};

/**
 * Static method to get pending requests for a specific booth
 */
DriverOfflineRequestSchema.statics.getPendingByBooth = async function(boothName) {
  return this.find({
    status: 'pending',
    boothName
  }).sort({ requestedAt: 1 });
};

/**
 * Static method to check if driver has pending request
 */
DriverOfflineRequestSchema.statics.hasPendingRequest = async function(driverId) {
  const request = await this.findOne({
    driverId,
    status: 'pending'
  });
  return !!request;
};

/**
 * Instance method to approve the request
 */
DriverOfflineRequestSchema.methods.approve = async function(adminId, adminName) {
  this.status = 'approved';
  this.processedAt = new Date();
  this.processedBy = adminId;
  this.processedByName = adminName;
  return this.save();
};

/**
 * Instance method to reject the request
 */
DriverOfflineRequestSchema.methods.reject = async function(adminId, adminName, reason = '') {
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
DriverOfflineRequestSchema.methods.cancel = async function() {
  this.status = 'cancelled';
  this.processedAt = new Date();
  return this.save();
};

/**
 * Pre-save middleware to set default expiry (1 hour from creation)
 */
DriverOfflineRequestSchema.pre('save', function(next) {
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  }
  next();
});

module.exports = mongoose.model('DriverOfflineRequest', DriverOfflineRequestSchema);
