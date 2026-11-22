'use strict';

/**
 * Start-up seeding: the fixed pickup location that the admin booking page, drivers and users look up
 * by name must exist in a brand new database, and restarts must not duplicate or undo changes to it.
 */

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { connectTemp, cleanup } = require('./helper');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const PickupLocation = require('../../models/PickupLocation');
const { FIXED_PICKUP_LOCATION, ensureFixedPickupLocation } = require('../../seeders/fixedPickupLocation');

let file;
before(async () => {
  file = await connectTemp('startup');
});
after(async () => {
  await cleanup(file);
});

describe('ensureFixedPickupLocation', () => {
  it('creates the pickup location in an empty database, findable the way manual booking looks it up', async () => {
    assert.equal(await PickupLocation.countDocuments(), 0);
    assert.equal(await ensureFixedPickupLocation(), true);

    const found = await PickupLocation.findOne({ name: 'Hauz Khas Metro Gate No 1', isActive: true });
    assert.ok(found, 'manual booking looks the pickup up by name and isActive');
    assert.equal(found.id, 'M-Y-024-GATE1');
    assert.equal(found.type, 'metro');
    assert.equal(found.lat, 28.5433);
    assert.equal(found.lng, 77.2066);
    assert.deepEqual(found.coordinates.coordinates, [77.2066, 28.5433]);
  });

  it('does nothing on the next start', async () => {
    assert.equal(await ensureFixedPickupLocation(), false);
    assert.equal(await PickupLocation.countDocuments(), 1);
  });

  it('does not undo a change made to the stored document', async () => {
    await PickupLocation.updateOne({ id: FIXED_PICKUP_LOCATION.id }, { $set: { isActive: false, priority: 3 } });
    assert.equal(await ensureFixedPickupLocation(), false);

    const stored = await PickupLocation.findOne({ id: FIXED_PICKUP_LOCATION.id });
    assert.equal(stored.isActive, false);
    assert.equal(stored.priority, 3);
    assert.equal(await PickupLocation.countDocuments(), 1);
  });

  it('does not add a second one when the same name exists under another id (for example imported data)', async () => {
    await PickupLocation.deleteMany({});
    await PickupLocation.create({
      id: 'IMPORTED-HKM',
      name: FIXED_PICKUP_LOCATION.name,
      type: 'metro',
      address: 'Hauz Khas',
      lat: 28.54,
      lng: 77.2,
      coordinates: { type: 'Point', coordinates: [77.2, 28.54] }
    });

    assert.equal(await ensureFixedPickupLocation(), false);
    const all = await PickupLocation.find({});
    assert.equal(all.length, 1);
    assert.equal(all[0].id, 'IMPORTED-HKM');
  });
});
