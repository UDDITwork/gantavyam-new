// middleware/executiveAccess.js
// Default-deny access list for executives ("executive-manager"): sub-admins of ONE pickup point who may only use
// four features - Fleet Manager, Queue Management, Register Driver and Manual Booking.
//
// adminProtect calls executiveMayCall() for every executive request, so an executive is refused on every admin
// route that is not listed here (users, financials, fares, settings, ride tools, other admins, ...), including
// routes added in the future. The routes in this list then limit the data to the executive's own pod.

const e = String.raw;

const ID = '[^/]+';

const ALLOWED = [
  // Shared
  ['GET', new RegExp(e`^/api/admin/pickup-locations/?$`)],

  // Register Driver
  ['POST', new RegExp(e`^/api/admin/drivers/?$`)],

  // Drivers of the own pod (Fleet Manager, Queue Management and Manual Booking list them)
  ['GET', new RegExp(e`^/api/admin/drivers/?$`)],

  // Rides of the own pod (Fleet Manager)
  ['GET', new RegExp(e`^/api/admin/rides/?$`)],

  // Manual Booking
  ['GET', new RegExp(e`^/api/admin/check-user/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/register-customer/?$`)],
  ['POST', new RegExp(e`^/api/admin/manual-booking/?$`)],
  ['GET', new RegExp(e`^/api/admin/manual-booking/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/submit-to-fleet-manager/?$`)],
  ['GET', new RegExp(e`^/api/admin/pending-fm-requests/?$`)],
  ['POST', new RegExp(e`^/api/admin/cancel-fm-request/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/cancel-pending/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/resend-otp/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/send-payment-link/?$`)],
  ['GET', new RegExp(e`^/api/admin/offline-requests/?$`)],

  // Fleet Manager
  ['GET', new RegExp(e`^/api/admin/fleet-manager/open-bookings/?$`)],
  ['GET', new RegExp(e`^/api/admin/fleet-manager/booking/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/fleet-manager/assign-driver/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/fleet-manager/cancel-booking/${ID}/?$`)],

  // Queue Management (drivers asking to go online)
  ['GET', new RegExp(e`^/api/admin/online-requests/?$`)],
  ['GET', new RegExp(e`^/api/admin/online-requests/count/?$`)],
  ['GET', new RegExp(e`^/api/admin/online-requests/by-booth/${ID}/?$`)],
  ['POST', new RegExp(e`^/api/admin/online-requests/${ID}/(approve|reject)/?$`)],
  ['POST', new RegExp(e`^/api/admin/online-requests/bulk-approve/?$`)]
];

// May an executive call this method + URL? (the query string is ignored)
function executiveMayCall(method, url) {
  const path = String(url || '').split('?')[0];
  const verb = String(method || '').toUpperCase();
  return ALLOWED.some(([allowedMethod, pattern]) => allowedMethod === verb && pattern.test(path));
}

module.exports = { executiveMayCall, ALLOWED };
