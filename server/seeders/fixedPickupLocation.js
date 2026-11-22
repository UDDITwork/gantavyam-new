const PickupLocation = require('../models/PickupLocation');

// The one pickup point the apps offer (client/src/config/fixedLocations.js has the same values).
// The admin booking page, drivers going online and the user app find it by name in the database,
// so a fresh database has to contain it.
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

// Creates the fixed pickup location when it is missing. An existing one (found by id or by name) is
// left exactly as it is, so changes made later, such as switching it off, are not undone on restart.
// Returns true when a new document was created.
async function ensureFixedPickupLocation() {
  const existing = await PickupLocation.findOne({
    $or: [{ id: FIXED_PICKUP_LOCATION.id }, { name: FIXED_PICKUP_LOCATION.name }]
  });
  if (existing) return false;

  try {
    await PickupLocation.create({
      ...FIXED_PICKUP_LOCATION,
      coordinates: { type: 'Point', coordinates: [FIXED_PICKUP_LOCATION.lng, FIXED_PICKUP_LOCATION.lat] }
    });
    return true;
  } catch (error) {
    // Two instances can start together during a rollout: the one that lost the race finds it already there
    if (error.code === 11000) return false;
    throw error;
  }
}

module.exports = { FIXED_PICKUP_LOCATION, ensureFixedPickupLocation };
