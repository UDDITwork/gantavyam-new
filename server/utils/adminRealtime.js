// utils/adminRealtime.js
// Live (Socket.IO) updates for the admin panel.
//
// Admins join the rooms "admins" / "admin-room" and receive everything. Executives are NOT in those rooms:
//  - bookings and rides belong to a pickup point: only the executives of that pod get their updates (room pod_<KEY>)
//  - drivers and the driver queue are shared: every executive gets those updates (room "executives")

const { podRoomForBooth, EXECUTIVES_ROOM } = require('./podScope');

// A broadcast about a booking / ride: the admins plus the executives of the pod the booth belongs to.
// `legacyRoom` is the room the call used before pods existed ('admins' or 'admin-room').
//   toAdmins(io, 'admin-room', booth).emit('newOpenBooking', payload)
// A socket in both rooms receives the event once. An unknown booth reaches the admins only.
function toAdmins(io, legacyRoom, booth) {
  const target = io.to(legacyRoom);
  const podRoom = podRoomForBooth(booth);
  return podRoom ? target.to(podRoom) : target;
}

// A broadcast about drivers or the queue (shared by both pods): the admins plus every executive
//   toAdminsAndExecutives(io, 'admins').emit('onlineRequestProcessed', payload)
function toAdminsAndExecutives(io, legacyRoom) {
  return io.to(legacyRoom).to(EXECUTIVES_ROOM);
}

module.exports = { toAdmins, toAdminsAndExecutives };
