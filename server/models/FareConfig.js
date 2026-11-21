const mongoose = require('../db');

// Vehicle pricing is now hardcoded as piecewise linear formulas in fareCalculator.js
// No vehicle config stored in DB — only night charge settings are configurable

const fareConfigSchema = new mongoose.Schema({
  // Night charge settings — only configurable fare parameters
  nightCharge: {
    isActive: {
      type: Boolean,
      default: true
    },
    startHour: {
      type: Number,
      default: 20, // 8 PM
      min: 0,
      max: 23
    },
    endHour: {
      type: Number,
      default: 8, // 8 AM
      min: 0,
      max: 23
    },
    userPercentage: {
      type: Number,
      default: 30, // +30% for customer at night
      min: 0,
      max: 100
    },
    driverPercentage: {
      type: Number,
      default: 25, // +25% for driver at night
      min: 0,
      max: 100
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin'
  },
  updatedByName: String,
  version: {
    type: Number,
    default: 1
  },
  effectiveFrom: {
    type: Date,
    default: Date.now
  },
  notes: String
}, {
  timestamps: true
});

// Create history when fare config is updated
fareConfigSchema.pre('save', async function(next) {
  if (!this.isNew) {
    this.version = this.version + 1;
  }
  next();
});

// Static method to get active config
fareConfigSchema.statics.getActiveConfig = async function() {
  let config = await this.findOne({ isActive: true }).sort('-createdAt');

  // If no config exists, create default one
  if (!config) {
    config = await this.create({
      nightCharge: {
        isActive: true,
        startHour: 20,
        endHour: 8,
        userPercentage: 30,
        driverPercentage: 25
      },
      isActive: true
    });
  }

  return config;
};

const FareConfig = mongoose.model('FareConfig', fareConfigSchema);

module.exports = FareConfig;
