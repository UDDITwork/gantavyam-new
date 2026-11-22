// routes/admin/executiveRoutes.js
// Admin-only management of executives: sub-admins tied to ONE pickup point (pod) who may only use Fleet Manager,
// Queue Management, Register Driver and Manual Booking for that pod.
//
// Mounted at /api/admin/executives. Only admins with the "admins:manage" permission get in; executives are
// refused earlier by adminProtect (middleware/executiveAccess.js). Passwords are only ever received here and
// stored hashed (Admin model); they are never logged or returned.

const express = require('express');
const router = express.Router();
const Admin = require('../../models/Admin');
const { adminProtect } = require('../../middleware/auth');
const { checkPermission, PERMISSIONS } = require('../../middleware/permissions');
const { getPod } = require('../../config/pickupPods');
const { EXECUTIVE_ROLE, publicPodOf } = require('../../utils/podScope');

router.use(adminProtect, checkPermission(PERMISSIONS.ADMINS_MANAGE));

const EMAIL_PATTERN = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,})+$/;
const MIN_PASSWORD_LENGTH = 8;

const serialize = (admin) => ({
  _id: admin._id,
  name: admin.name,
  email: admin.email,
  role: admin.role,
  assignedPickupLocation: admin.assignedPickupLocation || null,
  pod: publicPodOf(admin),
  isActive: admin.isActive !== false,
  lastLogin: admin.lastLogin || null,
  createdAt: admin.createdAt || null
});

const fail = (res, status, message) => res.status(status).json({ success: false, error: message, message });

// Changes to an executive (pod, password, deactivation, removal) take effect for the open live connections too:
// the executive is disconnected and their app reconnects with the new settings (or is refused when deactivated)
function disconnectExecutive(id) {
  try {
    const { getIO } = require('../../socket');
    getIO().in(`admin_${id}`).disconnectSockets(true);
  } catch (error) {
    // Socket.IO not running (tests) - nothing to disconnect
  }
}

// GET /api/admin/executives - all executives
router.get('/', async (req, res) => {
  try {
    const executives = await Admin.find({ role: EXECUTIVE_ROLE }).sort({ createdAt: -1 });
    res.json({ success: true, count: executives.length, data: executives.map(serialize) });
  } catch (error) {
    console.error('Error listing executives:', error.message);
    fail(res, 500, 'Could not load the executives');
  }
});

// POST /api/admin/executives - create an executive for a pickup point
router.post('/', async (req, res) => {
  try {
    const { name, email, password, assignedPickupLocation } = req.body || {};

    const cleanName = String(name || '').trim();
    const cleanEmail = String(email || '').trim().toLowerCase();
    const pod = getPod(assignedPickupLocation);

    if (!cleanName) return fail(res, 400, 'Please enter the executive\'s name');
    if (!EMAIL_PATTERN.test(cleanEmail)) return fail(res, 400, 'Please enter a valid e-mail address');
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return fail(res, 400, `The password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
    }
    if (!pod) return fail(res, 400, 'Please choose the pickup point of this executive');

    if (await Admin.findByEmail(cleanEmail)) {
      return fail(res, 409, 'An admin or executive with this e-mail already exists');
    }

    const executive = new Admin({
      name: cleanName,
      email: cleanEmail,
      password, // hashed by the Admin model before it is stored
      role: EXECUTIVE_ROLE,
      assignedPickupLocation: pod.key,
      isActive: true
    });
    await executive.save();

    console.log(`✅ Executive created for ${pod.name} by ${req.admin.email}: ${cleanEmail}`);
    res.status(201).json({ success: true, data: serialize(executive) });
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, 'An admin or executive with this e-mail already exists');
    if (error.name === 'ValidationError') return fail(res, 400, error.message);
    console.error('Error creating executive:', error.message);
    fail(res, 500, 'Could not create the executive');
  }
});

// Loads an executive by id; answers the request itself when there is none (other admins are never touched here)
async function loadExecutive(req, res) {
  let executive = null;
  try {
    executive = await Admin.findById(req.params.id);
  } catch (error) {
    executive = null;
  }
  if (!executive || executive.role !== EXECUTIVE_ROLE) {
    fail(res, 404, 'Executive not found');
    return null;
  }
  return executive;
}

// PUT /api/admin/executives/:id - change name, e-mail, pickup point, password or active state
router.put('/:id', async (req, res) => {
  try {
    const executive = await loadExecutive(req, res);
    if (!executive) return;

    const { name, email, password, assignedPickupLocation, isActive } = req.body || {};
    let mustReconnect = false;

    if (name !== undefined) {
      const cleanName = String(name).trim();
      if (!cleanName) return fail(res, 400, 'The name cannot be empty');
      executive.name = cleanName;
    }

    if (email !== undefined) {
      const cleanEmail = String(email).trim().toLowerCase();
      if (!EMAIL_PATTERN.test(cleanEmail)) return fail(res, 400, 'Please enter a valid e-mail address');
      if (cleanEmail !== String(executive.email).toLowerCase()) {
        const taken = await Admin.findByEmail(cleanEmail);
        if (taken && String(taken._id) !== String(executive._id)) {
          return fail(res, 409, 'An admin or executive with this e-mail already exists');
        }
        executive.email = cleanEmail;
      }
    }

    if (assignedPickupLocation !== undefined) {
      const pod = getPod(assignedPickupLocation);
      if (!pod) return fail(res, 400, 'Please choose a valid pickup point');
      if (pod.key !== executive.assignedPickupLocation) mustReconnect = true;
      executive.assignedPickupLocation = pod.key;
    }

    if (password !== undefined && password !== '') {
      if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return fail(res, 400, `The password must be at least ${MIN_PASSWORD_LENGTH} characters long`);
      }
      executive.password = password; // hashed by the Admin model before it is stored
      mustReconnect = true;
    }

    if (isActive !== undefined) {
      const active = isActive === true || isActive === 'true';
      if (!active && executive.isActive !== false) mustReconnect = true;
      executive.isActive = active;
    }

    await executive.save();
    if (mustReconnect) disconnectExecutive(executive._id);

    res.json({ success: true, data: serialize(executive) });
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, 'An admin or executive with this e-mail already exists');
    if (error.name === 'ValidationError') return fail(res, 400, error.message);
    console.error('Error updating executive:', error.message);
    fail(res, 500, 'Could not update the executive');
  }
});

// DELETE /api/admin/executives/:id - remove an executive
router.delete('/:id', async (req, res) => {
  try {
    const executive = await loadExecutive(req, res);
    if (!executive) return;

    await Admin.findByIdAndDelete(executive._id);
    disconnectExecutive(executive._id);

    console.log(`🗑️ Executive removed by ${req.admin.email}: ${executive.email}`);
    res.json({ success: true, message: 'Executive removed' });
  } catch (error) {
    console.error('Error deleting executive:', error.message);
    fail(res, 500, 'Could not remove the executive');
  }
});

module.exports = router;
