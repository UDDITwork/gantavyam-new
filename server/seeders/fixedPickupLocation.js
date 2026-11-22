const PickupLocation = require('../models/PickupLocation');

// The pickup points the apps offer (client/src/config/pickupPods.js and server/config/pickupPods.js have the same
// values). The admin booking page, drivers going online and the user app find them by name in the database,
// so a fresh database has to contain them.
const FIXED_PICKUP_LOCATION = {
  id: 'M-Y-024-GATE1',
  name: 'Hauz Khas Metro Gate No 1',
  type: 'metro',
  subType: 'Yellow Line',
  address: 'Hauz Khas Metro Station Gate No 1, Outer Ring Road, Hauz Khas, New Delhi',
  lat: 28.5433,
  lng: 77.2066,
  line: 'yellow',
  isActive: true,
  priority: 10,
  metadata: {
    description: 'Fixed pickup location - Hauz Khas Metro Station Gate No 1',
    facilities: ['parking', 'waiting_area']
  }
};

const PATEL_CHOWK_PICKUP_LOCATION = {
  id: 'M-Y-016',
  name: 'Patel Chowk Metro Station',
  type: 'metro',
  subType: 'Yellow Line',
  address: 'Patel Chowk Metro Station Exit No 1, Sansad Marg, New Delhi',
  lat: 28.622834,
  lng: 77.214126,
  line: 'yellow',
  isActive: true,
  priority: 9,
  metadata: {
    description: 'Pickup location - Patel Chowk Metro Station Exit No 1',
    facilities: ['parking', 'waiting_area']
  }
};

// Creates a pickup location when it is missing. An existing one (found by id or by name) is left exactly as
// it is, so changes made later, such as switching it off, are not undone on restart.
// Returns true when a new document was created.
async function ensurePickupLocation(location) {
  const existing = await PickupLocation.findOne({
    $or: [{ id: location.id }, { name: location.name }]
  });
  if (existing) return false;

  try {
    await PickupLocation.create({
      ...location,
      coordinates: { type: 'Point', coordinates: [location.lng, location.lat] }
    });
    return true;
  } catch (error) {
    // Two instances can start together during a rollout: the one that lost the race finds it already there
    if (error.code === 11000) return false;
    throw error;
  }
}

// The original fixed pickup point (Hauz Khas). Returns true when a new document was created.
const ensureFixedPickupLocation = () => ensurePickupLocation(FIXED_PICKUP_LOCATION);

// Every pickup point (Hauz Khas and Patel Chowk). Returns the names of the ones that were created.
async function ensurePickupLocations() {
  const created = [];
  for (const location of [FIXED_PICKUP_LOCATION, PATEL_CHOWK_PICKUP_LOCATION]) {
    if (await ensurePickupLocation(location)) created.push(location.name);
  }
  return created;
}

module.exports = {
  FIXED_PICKUP_LOCATION,
  PATEL_CHOWK_PICKUP_LOCATION,
  ensureFixedPickupLocation,
  ensurePickupLocations
};
