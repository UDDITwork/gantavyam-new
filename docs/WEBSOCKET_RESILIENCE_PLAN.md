# WebSocket Resilience & Queue Management System

**Created:** January 19, 2026
**Last Updated:** January 20, 2026
**Status:** Implemented (Admin-Only Queue Management Added)

---

## Implementation Summary

### Completed Features

| Feature | Status | Files Modified |
|---------|--------|----------------|
| Driver Online Request System | ✅ Done | socket.js, DriverOnlineRequest.js |
| Admin Approval Workflow | ✅ Done | QueueManagement.js, socket.js |
| 30-min Disconnection Timeout | ✅ Done | disconnectionMonitor.js |
| Queue Rotation (Back of Queue) | ✅ Done | socket.js |
| Engaged Driver Status | ✅ Done | QueueManagement.js, DriverStatusIndicator.js |
| Connection Status Fix | ✅ Done | socket.js |
| Admin Socket Auth Fix | ✅ Done | socket.js |

---

## Architecture Overview

### Driver Status Model

| Field | Type | Values | Purpose |
|-------|------|--------|---------|
| `isOnline` | Boolean | true/false | General online status |
| `inQueue` | Boolean | true/false | Queue membership |
| `connectionStatus` | Enum | 'connected' / 'disconnected' / 'offline' | Socket state |
| `currentRide` | ObjectId | ride ID or null | Currently assigned ride |
| `queuePosition` | Number | 1, 2, 3... or null | Position in queue |

### Status Display in Admin UI

| Status | Color | Icon | Condition |
|--------|-------|------|-----------|
| **Online** | Green | 🟢 | `connectionStatus === 'connected'` |
| **Not Reachable** | Yellow | 🟡 | `connectionStatus === 'disconnected' && inQueue` |
| **Engaged** | Orange | 🚕 | `currentRide !== null` |
| **Offline** | Gray | 🔴 | `connectionStatus === 'offline'` |

---

## Driver Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DRIVER LIFECYCLE                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [OFFLINE] ──(GO ONLINE)──▶ [PENDING APPROVAL]                      │
│      │                            │                                  │
│      │                     (admin approves)                          │
│      │                            ▼                                  │
│      │                    [ONLINE - Queue #1]                        │
│      │                            │                                  │
│      │                     (accepts ride)                            │
│      │                            ▼                                  │
│      │                    [ENGAGED 🚕]                               │
│      │               (inQueue: false, currentRide: set)              │
│      │                            │                                  │
│      │                     (ride completes)                          │
│      │                            ▼                                  │
│      │                    [ONLINE - Queue #LAST]                     │
│      │               (fair rotation for all drivers)                 │
│      │                                                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Queue Rotation System (Implemented)

### When Driver Accepts Ride
**File:** `server/socket.js` (driverAcceptRide handler)

```javascript
// Driver is removed from queue when accepting a ride
await Driver.findByIdAndUpdate(driver._id, {
  currentRide: rideRequest._id,
  isAvailable: false,
  inQueue: false,           // Remove from queue
  queuePosition: null       // Clear position
});

// Other drivers shift up
await updateQueueAfterDriverRemoval(driver._id);

// Broadcast "Engaged" status
broadcastStateChange('driverStatusChanged', {
  driverId: driver._id,
  inQueue: false,
  currentRide: rideRequest._id,
  reason: 'ride_accepted_engaged'
});
```

### When Ride Completes
**File:** `server/socket.js` (verifyEndOTP handler)

```javascript
// Clear current ride
await Driver.findByIdAndUpdate(driver._id, { currentRide: null });

// Re-add to queue at LAST position
await addDriverBackToQueue(driver._id, boothName);
```

### Helper Function: addDriverBackToQueue
**File:** `server/socket.js`

```javascript
const addDriverBackToQueue = async (driverId, boothName) => {
  // Count current online drivers to get last position
  const onlineDriverCount = await Driver.countDocuments({
    isOnline: true,
    inQueue: true,
    isVerified: true,
    _id: { $ne: driverId }
  });

  const newPosition = onlineDriverCount + 1;

  // Update driver with new queue position (at the END)
  await Driver.findByIdAndUpdate(driverId, {
    inQueue: true,
    queuePosition: newPosition,
    queueEntryTime: new Date(),
    lastActiveTime: new Date()
  });

  // Broadcast status change
  broadcastStateChange('driverStatusChanged', {
    driverId,
    inQueue: true,
    queuePosition: newPosition,
    reason: 'ride_completed_requeued'
  });
};
```

---

## Admin Queue Management UI

### Engaged Drivers Section
**File:** `client/src/pages/admin/QueueManagement.js`

- Separate section shows drivers currently on a ride
- Orange styling with 🚕 icon
- Engaged drivers excluded from main queue list
- Stats card shows "Engaged" count

### Filter Logic
```javascript
// Queue list (excludes engaged drivers)
const online = driversData
  .filter(driver => (driver.inQueue || driver.isOnline) && !driver.currentRide);

// Engaged drivers (separate section)
const engaged = driversData.filter(driver => driver.currentRide);
```

### Socket Listener Update
```javascript
socket.on('driverStatusChanged', (data) => {
  setDrivers(prevDrivers =>
    prevDrivers.map(driver =>
      driver._id === data.driverId
        ? {
            ...driver,
            isOnline: data.isOnline,
            inQueue: data.inQueue,
            connectionStatus: data.connectionStatus,
            queuePosition: data.queuePosition,
            currentRide: data.currentRide || null  // Track engaged status
          }
        : driver
    )
  );
});
```

---

## Bug Fixes Applied

### 1. connectionStatus Bug on Approval
**Problem:** After admin approves, driver showed "Not Reachable" even when socket connected.

**Fix:** Check if driver socket is actually connected before setting status.
```javascript
// server/socket.js - approveOnlineRequest handler
const driverSocketConnected = connectedClients.has(request.driverId.toString());
connectionStatus: driverSocketConnected ? 'connected' : 'disconnected',
```

### 2. socket.admin Undefined
**Problem:** Admin socket handlers failed because `socket.admin` was never set.

**Fix:** Load Admin document during socket authentication.
```javascript
// server/socket.js - authentication middleware
if (userRole === 'admin') {
  const admin = await Admin.findById(decoded.id);
  socket.admin = {
    _id: admin._id,
    fullName: admin.fullName || 'Admin',
    email: admin.email,
    permissions: admin.permissions
  };
}
```

### 3. Double /api/ URL Prefix
**Problem:** API calls going to `/api/api/admin/online-requests`.

**Fix:** Updated QueueManagement.js to use correct URL format.
```javascript
// Before (buggy)
`${REACT_APP_API_URL}/api/admin/online-requests`

// After (fixed)
`${REACT_APP_API_URL}/admin/online-requests`
```

### 4. Driver Validation Error
**Problem:** `driver.save()` triggered validation on unrelated fields.

**Fix:** Use `findByIdAndUpdate` instead of `save()` to skip validation.

### 5. "Set Offline" Button Setting Driver ONLINE (Fixed Jan 20, 2026)
**Problem:** Clicking "Set Offline" on a "Not Reachable" driver (yellow status) actually set them ONLINE.

**Root Cause:** The button used toggle logic based on `driver.isOnline`:
```javascript
// Old (buggy) code
onClick={() => toggleDriverStatus(driver._id, driver.isOnline)}
// For "Not Reachable" driver: isOnline=false, so sends isOnline: !false = true
```

**Fix:** Changed to dedicated `setDriverOffline` function that always sends `isOnline: false`:
```javascript
// client/src/pages/admin/QueueManagement.js
const setDriverOffline = async (driverId) => {
  socket.emit('adminToggleDriverStatus', {
    driverId,
    isOnline: false  // Always set offline
  });
};

// Button now calls:
onClick={() => setDriverOffline(driver._id)}
```

### 6. Duplicate Online Requests in Admin UI (Fixed Jan 20, 2026)
**Problem:** Multiple driver online requests appeared in the Requests tab when only one request was made.

**Root Cause:** No client-side deduplication in socket event handlers. Duplicates occurred when:
- Admin had multiple browser tabs open
- Socket reconnection caused replayed events
- Race condition between socket events and API polling

**Fix:** Added deduplication to all relevant socket handlers:
```javascript
// client/src/pages/admin/QueueManagement.js
socket.on('newOnlineRequest', (data) => {
  setPendingRequests(prev => {
    // Deduplicate: check if request already exists
    if (prev.find(r => r._id === data.request?._id)) {
      return prev; // Skip duplicate
    }
    setPendingRequestsCount(count => count + 1);
    return [data.request, ...prev];
  });
});
```

Also fixed count synchronization to only decrement when actually removing items.

### 7. Driver Auto-Online After Logout/Login Bug (Fixed Jan 20, 2026)
**Problem:** When driver intentionally logged out (clicked "Sign Out") and logged back in, they were automatically shown as online without needing new admin approval.

**Root Cause:** The `handleLogout` function in ModernDriverDashboard.js only cleared `driverToken` and `driverInfo`, but NOT the driver status localStorage keys. On next login, `recoverState()` restored the old `isOnline: true` state.

**Affected Code (before fix):**
```javascript
// client/src/components/driver/minimal/ModernDriverDashboard.js
const handleLogout = () => {
  localStorage.removeItem('driverToken');
  localStorage.removeItem('driverInfo');
  navigate('/driver/login');
};
```

**Fix:** Updated `handleLogout` to properly clear all driver state:
```javascript
const handleLogout = () => {
  // First, tell server driver is going offline (if online)
  // This sets inQueue: false on server, preventing auto-restore on reconnect
  if (isOnline && socket) {
    socket.emit('driverGoOffline');
  }

  // Clear ALL driver state from localStorage (via DriverStateContext)
  // This clears: driverStatus, driverQueuePosition, driverActiveRide, driverLastKnownState
  if (actions && actions.clearState) {
    actions.clearState();
  }

  // Clear auth tokens
  localStorage.removeItem('driverToken');
  localStorage.removeItem('driverInfo');
  localStorage.removeItem('driver');

  navigate('/driver/login');
};
```

**Key Distinction:**
- **Brief disconnect (app close/network issue):** Auto-restores (keeps approval) ✓
- **Intentional logout (Sign Out button):** Requires new approval ✓

---

## 30-Minute Disconnection Timeout

**File:** `server/services/disconnectionMonitor.js`

```javascript
const TIMEOUT_MINUTES = 30;
const CHECK_INTERVAL_MS = 60 * 1000; // Check every minute

// Finds drivers to remove:
const expiredDrivers = await Driver.find({
  inQueue: true,
  connectionStatus: 'disconnected',
  currentRide: null,              // CRITICAL: Don't timeout if mid-ride!
  lastActiveTime: { $lt: threshold }
});
```

**Key Protection:** Drivers with active rides (`currentRide !== null`) are NEVER timed out.

---

## Driver Online Request System

### Model: DriverOnlineRequest
**File:** `server/models/DriverOnlineRequest.js`

```javascript
{
  driverId: ObjectId,
  driverName: String,
  driverPhone: String,
  boothName: String,
  vehicleType: 'auto' | 'bike' | 'car',
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled',
  requestedAt: Date,
  expiresAt: Date,  // TTL index for auto-cleanup
  processedBy: ObjectId,
  processedByName: String
}
```

### API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/admin/online-requests` | List pending requests |
| GET | `/api/admin/online-requests/count` | Count for badge |
| POST | `/api/admin/online-requests/:id/approve` | Approve driver |
| POST | `/api/admin/online-requests/:id/reject` | Reject driver |
| GET | `/api/drivers/my-online-request` | Check request status |

---

## Files Modified

### Server Files
| File | Changes |
|------|---------|
| `server/socket.js` | Queue rotation, engaged status, connection fix, admin auth |
| `server/models/DriverOnlineRequest.js` | Online request model |
| `server/routes/admin/driverOnlineRequestRoutes.js` | Admin approval APIs |
| `server/routes/driverOnlineRequest.js` | Driver request APIs |
| `server/services/disconnectionMonitor.js` | 30-min timeout service |

### Client Files
| File | Changes |
|------|---------|
| `client/src/pages/admin/QueueManagement.js` | Engaged section, socket listener, filter fix, Set Offline button fix, deduplication |
| `client/src/components/admin/DriverStatusIndicator.js` | Engaged status display |
| `client/src/components/driver/minimal/ModernDriverDashboard.js` | Pending approval banner, logout state cleanup fix |

---

## Testing Checklist

- [x] Driver clicks "Go Online" → Pending approval state
- [x] Admin approves → Driver added to queue with correct connectionStatus
- [x] Driver accepts ride → Removed from queue, shows "Engaged"
- [x] Other drivers' positions shift up
- [x] Ride completes → Driver added back at LAST position
- [x] Ride cancelled → Driver added back at LAST position
- [x] Admin UI shows "Engaged" section with orange badges
- [x] 30-min timeout only for disconnected drivers WITHOUT active ride
- [x] Socket.admin properly set for admin authentication
- [x] "Set Offline" button always sets driver offline (not toggle)
- [x] No duplicate requests in admin Request tab
- [x] Driver logout → login again → Should be OFFLINE (requires new approval)

---

## Real-Life Scenarios Covered

| # | Scenario | How It's Handled |
|---|----------|------------------|
| 1 | Driver requests online | Creates request, shows yellow banner |
| 2 | Admin approves | Checks socket connection, sets correct status |
| 3 | Driver accepts ride | Removed from queue, shows "Engaged" |
| 4 | Ride completes | Driver goes to back of queue (fair rotation) |
| 5 | Socket disconnects mid-ride | OTP works via REST API, driver not timed out |
| 6 | 30-min timeout | Only if disconnected AND no active ride |
| 7 | Admin assigns disconnected driver | Warning popup, can choose to assign anyway |
| 8 | Driver reconnects | Socket reconnect restores "connected" status |
| 9 | Driver intentionally logs out | Stays in queue as "Not Reachable" - admin removes |
| 10 | Driver clicks "Go Offline" | Creates offline request - admin approves |
| 11 | Admin clicks "Remove from Queue" | Directly removes driver from queue |

---

## Admin-Only Queue Management System (Implemented Jan 20, 2026)

### Overview

The queue is now fully controlled by admins:
- **Joining Queue:** Driver requests -> Admin approves -> Driver joins
- **Leaving Queue:** Driver requests -> Admin approves -> Driver removed
- **Admin Direct:** Admin can remove any driver directly
- **Connection Loss:** Driver stays in queue as "Not Reachable" (no auto-removal)

### Key Changes Made

| Component | Change |
|-----------|--------|
| **Disconnection Monitor** | Auto-removal DISABLED - drivers stay in queue forever |
| **Driver "Go Offline"** | Creates DriverOfflineRequest instead of direct offline |
| **Driver Logout** | Stays in queue as "Not Reachable" |
| **Admin "Set Offline"** | Renamed to "Remove from Queue" |

### New Model: DriverOfflineRequest

**File:** `server/models/DriverOfflineRequest.js`

```javascript
{
  driverId: ObjectId,
  driverName: String,
  driverPhone: String,
  boothName: String,
  queuePosition: Number,
  reason: String,
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled',
  requestedAt: Date,
  expiresAt: Date,
  processedBy: ObjectId,
  processedByName: String,
  processedAt: Date
}
```

### New Socket Events

| Event | Direction | Purpose |
|-------|-----------|---------|
| `newOfflineRequest` | Server -> Admin | New offline request notification |
| `offlineRequestProcessed` | Server -> All | Request processed notification |
| `approveOfflineRequest` | Admin -> Server | Approve offline request |
| `rejectOfflineRequest` | Admin -> Server | Reject offline request |
| `adminRemoveFromQueue` | Admin -> Server | Direct queue removal |
| `offlineRequestApproved` | Server -> Driver | Approval confirmation |
| `offlineRequestRejected` | Server -> Driver | Rejection notification |

### Admin UI Updates (QueueManagement.js)

1. **Queue Tab:**
   - "Set Offline" button renamed to "Remove from Queue"
   - Directly removes driver without request workflow

2. **Requests Tab:**
   - Shows both Online AND Offline requests
   - Green section: Online requests (driver wants to join)
   - Red section: Offline requests (driver wants to leave)
   - Approve/Reject buttons for both types

3. **Badge Count:**
   - Shows total of online + offline pending requests

### Driver Dashboard Updates (ModernDriverDashboard.js)

1. **"Go Offline" Button:**
   - Creates offline request
   - Shows "Waiting for admin approval" banner

2. **Logout:**
   - Does NOT emit driverGoOffline
   - Driver stays in queue as "Not Reachable"
   - Admin must manually remove

### Testing Checklist

- [ ] Driver clicks "Go Offline" -> Shows pending banner, stays in queue
- [ ] Admin approves offline request -> Driver removed from queue
- [ ] Admin rejects offline request -> Driver stays in queue, banner dismissed
- [ ] Driver closes tab -> Shows "Not Reachable", NO auto-removal after 30 min
- [ ] Driver logs out -> Stays in queue as "Not Reachable"
- [ ] Admin clicks "Remove from Queue" -> Driver immediately removed
- [ ] Driver reconnects after disconnect -> Restores to same queue position

---

## Future Improvements (Not Yet Implemented)

- [ ] Push notifications for disconnected drivers
- [ ] REST API for ride acceptance (polling fallback)
- [ ] Driver heartbeat/ping mechanism
- [ ] Service worker for background notifications
