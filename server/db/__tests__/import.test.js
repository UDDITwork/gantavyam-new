'use strict';

const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectTemp, cleanup } = require('./helper');
const { importExport, fromExtendedJson } = require('../../scripts/importMongoExport');

let file;
let dir;
before(async () => {
  file = await connectTemp('import');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gantavyam-import-'));
});
after(async () => {
  await cleanup(file);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MongoDB export import', () => {
  it('converts Extended JSON values', () => {
    assert.equal(fromExtendedJson({ $oid: '6B01BB5CEF7B55E0756D6621' }), '6b01bb5cef7b55e0756d6621');
    assert.equal(fromExtendedJson({ $date: '2026-01-02T03:04:05.000Z' }), '2026-01-02T03:04:05.000Z');
    assert.equal(fromExtendedJson({ $date: { $numberLong: '1767323045000' } }), new Date(1767323045000).toISOString());
    assert.equal(fromExtendedJson({ n: { $numberInt: '7' }, d: { $numberDouble: '1.5' } }).n, 7);
    assert.deepEqual(fromExtendedJson([{ $oid: 'a'.repeat(24) }, { x: { $date: '2026-05-05T00:00:00Z' } }]), ['a'.repeat(24), { x: '2026-05-05T00:00:00.000Z' }]);
  });

  it('loads exported collections (JSON array and one-document-per-line) and the models can read them', async () => {
    const userId = '6b01bb5cef7b55e0756d6621';
    const rideId = '6b01bb5cef7b55e0756d6622';
    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify([
        { _id: { $oid: userId }, name: 'Imported', phone: '9000012345', password: '$2a$10$hash', createdAt: { $date: '2025-12-31T10:00:00.000Z' }, lastLogin: { $date: '2026-01-01T00:00:00.000Z' }, __v: 0 },
      ])
    );
    fs.writeFileSync(
      path.join(dir, 'riderequests.jsonl'),
      `${JSON.stringify({ _id: { $oid: rideId }, userId: { $oid: userId }, userName: 'Imported', userPhone: '9000012345', distance: 3, fare: 90, estimatedFare: 90, vehicleType: 'auto', rideId: 'RIDE-IMP-1', status: 'pending', timestamp: { $date: '2026-01-01T09:00:00.000Z' } })}\n`
    );

    const logs = [];
    const summary = await importExport(dir, { log: (m) => logs.push(m) });
    assert.equal(summary.users.inserted, 1);
    assert.equal(summary.riderequests.inserted, 1);

    const User = require('../../models/User');
    const RideRequest = require('../../models/RideRequest');
    const user = await User.findById(userId).select('+password');
    assert.equal(user.name, 'Imported');
    assert.equal(user.password, '$2a$10$hash');
    assert.ok(user.createdAt instanceof Date);
    assert.equal(user.createdAt.toISOString(), '2025-12-31T10:00:00.000Z');

    const ride = await RideRequest.findOne({ rideId: 'RIDE-IMP-1' }).populate('userId', 'name');
    assert.equal(ride.userId.name, 'Imported');
    assert.equal(ride.status, 'pending');
    assert.equal(await RideRequest.countDocuments({ userId }), 1);
  });

  it('skips documents that are already present and can replace them on request', async () => {
    const summary = await importExport(dir, { log: () => {} });
    assert.equal(summary.users.inserted, 0);
    assert.equal(summary.users.skipped, 1);

    fs.writeFileSync(
      path.join(dir, 'users.json'),
      JSON.stringify([{ _id: { $oid: '6b01bb5cef7b55e0756d6621' }, name: 'Replaced', phone: '9000012345', password: '$2a$10$hash' }])
    );
    const replaced = await importExport(dir, { replace: true, log: () => {} });
    assert.equal(replaced.users.inserted, 1);
    const User = require('../../models/User');
    assert.equal((await User.findById('6b01bb5cef7b55e0756d6621')).name, 'Replaced');
  });

  it('writes nothing in dry-run mode', async () => {
    const User = require('../../models/User');
    const before = await User.countDocuments({});
    fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ _id: { $oid: '6b01bb5cef7b55e0756d6699' }, name: 'Ghost', phone: '1', password: 'x' }]));
    const summary = await importExport(dir, { dryRun: true, log: () => {} });
    assert.equal(summary.users.read, 1);
    assert.equal(await User.countDocuments({}), before);
  });
});
