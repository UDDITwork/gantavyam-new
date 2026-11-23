import React, { useEffect, useState, useCallback, useRef } from 'react';
import { FiWifi, FiWifiOff, FiUser, FiClock, FiMapPin, FiPhone, FiRefreshCw, FiUsers, FiArrowUp, FiArrowDown, FiList, FiCheckCircle, FiXCircle, FiBell } from 'react-icons/fi';
import { admin as adminAPI } from '../../services/api';
import { initializeSocket, getSocket } from '../../services/socket';
import { getImageUrl } from '../../utils/imageUtils';
import ModernCard from '../../components/admin/ModernCard';
import api from '../../services/api';
import { useAdmin } from '../../contexts/AdminContext';
import { loginPathAfterSessionEnds } from '../../config/executiveLogin';

const QueueManagement = () => {
  const { isExecutive } = useAdmin();
  const [drivers, setDrivers] = useState([]);
  const [onlineDrivers, setOnlineDrivers] = useState([]);
  const [engagedDrivers, setEngagedDrivers] = useState([]); // Drivers currently on a ride
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [queueStats, setQueueStats] = useState({
    total: 0,
    online: 0,
    offline: 0,
    averageWaitTime: 0
  });

  // New state for Requests tab
  const [activeTab, setActiveTab] = useState('queue'); // 'queue' | 'requests'
  const [pendingRequests, setPendingRequests] = useState([]); // Online requests
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [processingRequestId, setProcessingRequestId] = useState(null);

  // Offline requests state (Admin-Only Queue Management)
  const [pendingOfflineRequests, setPendingOfflineRequests] = useState([]);
  const [pendingOfflineRequestsCount, setPendingOfflineRequestsCount] = useState(0);

  // Audio notification ref
  const audioRef = useRef(null);

  // Play notification sound
  const playNotificationSound = () => {
    if (audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(err => {
        console.log('Could not play notification sound:', err);
      });
    }
  };

  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (!token) {
      window.location.href = loginPathAfterSessionEnds();
    } else {
      // Initialize socket for real-time updates
      const initializeSocketAsync = async () => {
        try {
          const socketResult = initializeSocket(token);
          
          // Handle different return types from initializeSocket
          if (socketResult && typeof socketResult.then === 'function') {
            // It's a Promise
            const socket = await socketResult;
            if (socket) {
              console.log('[QueueManagement] Socket initialized successfully (Promise), setting up listeners');
              setupSocketListeners();
            } else {
              console.error('[QueueManagement] Failed to initialize socket (Promise returned null)');
            }
          } else if (socketResult) {
            // It's a direct socket object
            console.log('[QueueManagement] Socket initialized successfully (direct), setting up listeners');
            setupSocketListeners();
          } else {
            console.error('[QueueManagement] Failed to initialize socket (returned null)');
          }
        } catch (error) {
          console.error('[QueueManagement] Error initializing socket:', error);
        }
      };
      
      initializeSocketAsync();
    }
  }, []);

  useEffect(() => {
    fetchDrivers();
    // Refresh every 30 seconds
    const interval = setInterval(fetchDrivers, 30000);
    return () => clearInterval(interval);
  }, []);

  const setupSocketListeners = () => {
    const socket = getSocket();
    if (!socket) {
      console.error('[QueueManagement] Socket not available for setting up listeners');
      return;
    }

    console.log('[QueueManagement] Setting up socket listeners');
    
    // Verify socket connection status
    if (!socket.connected) {
      console.warn('[QueueManagement] Socket not connected, waiting for connection...');
      socket.on('connect', () => {
        console.log('[QueueManagement] Socket connected, setting up listeners');
        setupActualListeners();
      });
    } else {
      console.log('[QueueManagement] Socket already connected');
      setupActualListeners();
    }

    function setupActualListeners() {
      // CRITICAL FIX: Remove old listeners first to prevent duplicates on reconnection
      // Without this, listeners are registered multiple times when socket reconnects,
      // causing events to fire multiple times (e.g., 2 requests shown when driver sends 1)
      socket.off('driverStatusUpdated');
      socket.off('driverOnline');
      socket.off('driverOffline');
      socket.off('queueValidationResult');
      socket.off('queueValidationError');
      socket.off('queuePositionUpdated');
      socket.off('queuePositionsUpdated');
      socket.off('driverStatusChanged');
      socket.off('driverNotReachable');
      socket.off('driverReconnected');
      socket.off('newOnlineRequest');
      socket.off('onlineRequestProcessed');
      socket.off('onlineRequestCancelled');
      socket.off('approveOnlineRequestResult');
      socket.off('rejectOnlineRequestResult');
      socket.off('newOfflineRequest');
      socket.off('offlineRequestProcessed');
      socket.off('approveOfflineRequestResult');
      socket.off('rejectOfflineRequestResult');
      socket.off('adminRemoveFromQueueResult');

      // Listen for driver status updates
      socket.on('driverStatusUpdated', (data) => {
        console.log('[QueueManagement] Driver status updated:', data);
        updateDriverStatus(data);
      });

      // Listen for driver online/offline events
      socket.on('driverOnline', (data) => {
        console.log('[QueueManagement] Driver went online:', data);
        console.log('[QueueManagement] Queue entry time:', data.queueEntryTime || data.lastActiveTime);
        updateDriverStatus({ ...data, isOnline: true });
      });

      socket.on('driverOffline', (data) => {
        console.log('[QueueManagement] Driver went offline:', data);
        updateDriverStatus({ ...data, isOnline: false });
      });

      // Listen for queue validation results
      socket.on('queueValidationResult', (data) => {
        console.log('[QueueManagement] Queue validation result:', data);
        if (data.success) {
          setSuccess(data.message);
          setTimeout(() => setSuccess(''), 3000);
        }
      });

      socket.on('queueValidationError', (data) => {
        console.log('[QueueManagement] Queue validation error:', data);
        setError(data.error || 'Queue validation failed');
        setTimeout(() => setError(''), 3000);
      });

      // Listen for queue position updates
      socket.on('queuePositionUpdated', (data) => {
        console.log('[QueueManagement] Queue position updated:', data);
        updateQueuePosition(data);
      });

      // Listen for complete queue position updates
      socket.on('queuePositionsUpdated', (data) => {
        console.log('[QueueManagement] Complete queue positions updated:', data);
        if (data.queueUpdates) {
          // Update all drivers with new queue positions
          setDrivers(prevDrivers => {
            const updatedDrivers = prevDrivers.map(driver => {
              const queueUpdate = data.queueUpdates.find(q => q.driverId === driver._id);
              if (queueUpdate) {
                return {
                  ...driver,
                  queuePosition: queueUpdate.queuePosition,
                  isOnline: queueUpdate.isOnline,
                  inQueue: queueUpdate.inQueue,
                  connectionStatus: queueUpdate.connectionStatus,
                  currentPickupLocation: queueUpdate.currentPickupLocation,
                  lastActiveTime: queueUpdate.lastActiveTime,
                  queueEntryTime: queueUpdate.queueEntryTime || queueUpdate.lastActiveTime
                };
              }
              return driver;
            });
            return updatedDrivers;
          });

          // Update online drivers with new positions (now includes disconnected drivers in queue)
          setOnlineDrivers(prevOnline => {
            const updatedOnline = data.queueUpdates
              .filter(update => update.inQueue || update.isOnline) // Include all queued drivers
              .map(update => ({
                ...update,
                _id: update.driverId,
                fullName: update.driverName,
                queueEntryTime: update.queueEntryTime || update.lastActiveTime
              }))
              .sort((a, b) => {
                // Sort by queue entry time (first-come-first-served)
                if (a.queueEntryTime && b.queueEntryTime) {
                  return new Date(a.queueEntryTime) - new Date(b.queueEntryTime);
                }
                return (a.queuePosition || 999) - (b.queuePosition || 999);
              });

            console.log('[QueueManagement] Updated queued drivers with new positions (sorted by entry time)');
            return updatedOnline;
          });

          // Update stats
          setQueueStats(prevStats => ({
            ...prevStats,
            online: data.totalOnline,
            offline: prevStats.total - data.totalOnline,
            averageWaitTime: data.totalOnline * 5
          }));
        }
      });

      // NEW: Listen for driver status changes (comprehensive updates)
      socket.on('driverStatusChanged', (data) => {
        console.log('[QueueManagement] Driver status changed:', data);
        setDrivers(prevDrivers =>
          prevDrivers.map(driver =>
            driver._id === data.driverId
              ? {
                  ...driver,
                  isOnline: data.isOnline,
                  inQueue: data.inQueue,
                  connectionStatus: data.connectionStatus,
                  queuePosition: data.queuePosition,
                  currentPickupLocation: data.currentPickupLocation,
                  lastActiveTime: data.lastActiveTime,
                  currentRide: data.currentRide || null  // Track engaged status
                }
              : driver
          )
        );

        // Refresh the queue list
        fetchDrivers();
      });

      // NEW: Listen for driver not reachable (disconnected but in queue)
      socket.on('driverNotReachable', (data) => {
        console.log('[QueueManagement] Driver not reachable:', data);
        setDrivers(prevDrivers =>
          prevDrivers.map(driver =>
            driver._id === data.driverId
              ? {
                  ...driver,
                  isOnline: false,
                  connectionStatus: 'disconnected',
                  lastActiveTime: data.lastActiveTime
                  // Keep inQueue and queuePosition unchanged
                }
              : driver
          )
        );
      });

      // NEW: Listen for driver reconnected
      socket.on('driverReconnected', (data) => {
        console.log('[QueueManagement] Driver reconnected:', data);
        setDrivers(prevDrivers =>
          prevDrivers.map(driver =>
            driver._id === data.driverId
              ? {
                  ...driver,
                  isOnline: true,
                  connectionStatus: 'connected',
                  lastActiveTime: new Date().toISOString()
                }
              : driver
          )
        );
      });

      // NEW: Listen for online request events
      socket.on('newOnlineRequest', (data) => {
        console.log('[QueueManagement] New online request:', data);
        setPendingRequests(prev => {
          // Deduplicate: check if request already exists
          if (prev.find(r => r._id === data.request?._id)) {
            console.log('[QueueManagement] Duplicate request ignored:', data.request?._id);
            return prev;
          }
          // Only increment count if we're actually adding a new request
          setPendingRequestsCount(count => count + 1);
          return [data.request, ...prev];
        });
        // Play notification sound
        playNotificationSound();
      });

      socket.on('onlineRequestProcessed', (data) => {
        console.log('[QueueManagement] Online request processed:', data);
        setPendingRequests(prev => {
          const filtered = prev.filter(r => r._id !== data.requestId);
          // Only decrement count if we actually removed something
          if (filtered.length < prev.length) {
            setPendingRequestsCount(count => Math.max(0, count - 1));
          }
          return filtered;
        });
        if (data.status === 'approved') {
          fetchDrivers(); // Refresh queue when driver approved
        }
      });

      socket.on('onlineRequestCancelled', (data) => {
        console.log('[QueueManagement] Online request cancelled:', data);
        setPendingRequests(prev => {
          const filtered = prev.filter(r => r._id !== data.requestId);
          // Only decrement count if we actually removed something
          if (filtered.length < prev.length) {
            setPendingRequestsCount(count => Math.max(0, count - 1));
          }
          return filtered;
        });
      });

      socket.on('approveOnlineRequestResult', (data) => {
        console.log('[QueueManagement] Approve request result:', data);
        if (data.success && data.request?._id) {
          setSuccess(`${data.request?.driverName || 'Driver'} has been approved`);
          setPendingRequests(prev => {
            const filtered = prev.filter(r => r._id !== data.request._id);
            // Only decrement count if we actually removed something
            if (filtered.length < prev.length) {
              setPendingRequestsCount(count => Math.max(0, count - 1));
            }
            return filtered;
          });
          fetchDrivers();
        } else if (!data.success) {
          setError(data.error || 'Failed to approve request');
        }
        setProcessingRequestId(null);
        setTimeout(() => { setError(''); setSuccess(''); }, 3000);
      });

      socket.on('rejectOnlineRequestResult', (data) => {
        console.log('[QueueManagement] Reject request result:', data);
        if (data.success && data.request?._id) {
          setSuccess(`Request has been rejected`);
          setPendingRequests(prev => {
            const filtered = prev.filter(r => r._id !== data.request._id);
            // Only decrement count if we actually removed something
            if (filtered.length < prev.length) {
              setPendingRequestsCount(count => Math.max(0, count - 1));
            }
            return filtered;
          });
        } else if (!data.success) {
          setError(data.error || 'Failed to reject request');
        }
        setProcessingRequestId(null);
        setTimeout(() => { setError(''); setSuccess(''); }, 3000);
      });

      // NEW: Listen for OFFLINE request events (Admin-Only Queue Management)
      socket.on('newOfflineRequest', (data) => {
        console.log('[QueueManagement] New offline request:', data);
        setPendingOfflineRequests(prev => {
          // Deduplicate: check if request already exists
          if (prev.find(r => r._id === data.request?._id)) {
            console.log('[QueueManagement] Duplicate offline request ignored:', data.request?._id);
            return prev;
          }
          setPendingOfflineRequestsCount(count => count + 1);
          return [data.request, ...prev];
        });
        // Play notification sound
        playNotificationSound();
      });

      socket.on('offlineRequestProcessed', (data) => {
        console.log('[QueueManagement] Offline request processed:', data);
        setPendingOfflineRequests(prev => {
          const filtered = prev.filter(r => r._id !== data.requestId);
          if (filtered.length < prev.length) {
            setPendingOfflineRequestsCount(count => Math.max(0, count - 1));
          }
          return filtered;
        });
        if (data.status === 'approved') {
          fetchDrivers(); // Refresh queue when driver approved for offline
        }
      });

      socket.on('approveOfflineRequestResult', (data) => {
        console.log('[QueueManagement] Approve offline request result:', data);
        if (data.success && data.request?._id) {
          setSuccess(`${data.request?.driverName || 'Driver'} is now offline`);
          setPendingOfflineRequests(prev => {
            const filtered = prev.filter(r => r._id !== data.request._id);
            if (filtered.length < prev.length) {
              setPendingOfflineRequestsCount(count => Math.max(0, count - 1));
            }
            return filtered;
          });
          fetchDrivers();
        } else if (!data.success) {
          setError(data.error || 'Failed to approve offline request');
        }
        setProcessingRequestId(null);
        setTimeout(() => { setError(''); setSuccess(''); }, 3000);
      });

      socket.on('rejectOfflineRequestResult', (data) => {
        console.log('[QueueManagement] Reject offline request result:', data);
        if (data.success && data.request?._id) {
          setSuccess(`Offline request has been rejected`);
          setPendingOfflineRequests(prev => {
            const filtered = prev.filter(r => r._id !== data.request._id);
            if (filtered.length < prev.length) {
              setPendingOfflineRequestsCount(count => Math.max(0, count - 1));
            }
            return filtered;
          });
        } else if (!data.success) {
          setError(data.error || 'Failed to reject offline request');
        }
        setProcessingRequestId(null);
        setTimeout(() => { setError(''); setSuccess(''); }, 3000);
      });

      socket.on('adminRemoveFromQueueResult', (data) => {
        console.log('[QueueManagement] Admin remove from queue result:', data);
        if (data.success) {
          setSuccess(`${data.driverName || 'Driver'} has been removed from the queue`);
          fetchDrivers();
        } else {
          setError(data.error || 'Failed to remove driver from queue');
        }
        setTimeout(() => { setError(''); setSuccess(''); }, 3000);
      });

      console.log('[QueueManagement] All event listeners set up successfully');
    }
  };

  const updateDriverStatus = (data) => {
    setDrivers(prevDrivers =>
      prevDrivers.map(driver =>
        driver._id === data.driverId
          ? {
              ...driver,
              isOnline: data.isOnline,
              inQueue: data.inQueue !== undefined ? data.inQueue : driver.inQueue,
              connectionStatus: data.connectionStatus || (data.isOnline ? 'connected' : 'offline'),
              currentPickupLocation: data.currentPickupLocation,
              lastActiveTime: data.lastActiveTime || new Date(),
              queuePosition: data.queuePosition !== undefined ? data.queuePosition : driver.queuePosition,
              queueEntryTime: data.queueEntryTime || (data.isOnline ? new Date() : driver.queueEntryTime)
            }
          : driver
      )
    );
    
    // Update queue drivers list (includes both connected and disconnected)
    setOnlineDrivers(prevOnline => {
      const inQueue = data.inQueue !== undefined ? data.inQueue : data.isOnline;

      if (inQueue) {
        const exists = prevOnline.find(d => d._id === data.driverId);
        if (!exists) {
          const driver = drivers.find(d => d._id === data.driverId);
          if (driver) {
            const newOnline = [...prevOnline, {
              ...driver,
              isOnline: data.isOnline,
              inQueue: data.inQueue,
              connectionStatus: data.connectionStatus || (data.isOnline ? 'connected' : 'offline'),
              currentPickupLocation: data.currentPickupLocation,
              lastActiveTime: data.lastActiveTime || new Date(),
              queuePosition: data.queuePosition || prevOnline.length + 1,
              queueEntryTime: data.queueEntryTime || new Date()
            }].sort((a, b) => {
              // Sort by queue entry time (first-come-first-served)
              if (a.queueEntryTime && b.queueEntryTime) {
                return new Date(a.queueEntryTime) - new Date(b.queueEntryTime);
              }
              return (a.queuePosition || 999) - (b.queuePosition || 999);
            });
            return newOnline;
          }
        }
        return prevOnline;
      } else {
        // Only remove from queue if inQueue is explicitly false (not just disconnected)
        return prevOnline.filter(d => d._id !== data.driverId);
      }
    });
  };

  const updateQueuePosition = (data) => {
    setOnlineDrivers(prevOnline => 
      prevOnline.map(driver => 
        driver._id === data.driverId 
          ? { ...driver, queuePosition: data.queuePosition }
          : driver
      ).sort((a, b) => (a.queuePosition || 999) - (b.queuePosition || 999))
    );
  };

  const fetchDrivers = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminAPI.getAllDrivers();
      const driversData = res.data || [];
      setDrivers(driversData);
      
      // Filter and sort drivers in queue (includes both connected and disconnected, excludes engaged)
      const online = driversData
        .filter(driver => (driver.inQueue || driver.isOnline) && !driver.currentRide) // Exclude engaged drivers from queue
        .sort((a, b) => {
          // First sort by queue entry time (first-come-first-served)
          if (a.queueEntryTime && b.queueEntryTime) {
            return new Date(a.queueEntryTime) - new Date(b.queueEntryTime);
          }
          // If no queue entry time, fall back to last active time
          if (a.lastActiveTime && b.lastActiveTime) {
            return new Date(a.lastActiveTime) - new Date(b.lastActiveTime);
          }
          // Finally, fall back to queue position
          return (a.queuePosition || 999) - (b.queuePosition || 999);
        })
        .map((driver, index) => ({
          ...driver,
          queuePosition: index + 1 // Reassign positions based on sorted order
        }));
      
      setOnlineDrivers(online);

      // Filter engaged drivers (currently on a ride)
      const engaged = driversData.filter(driver => driver.currentRide);
      setEngagedDrivers(engaged);
      console.log('[QueueManagement] Engaged drivers:', engaged.map(d => d.fullName));

      // Debug logging for queue order
      console.log('[QueueManagement] Queue order after fetch:');
      online.forEach((driver, index) => {
        console.log(`  ${index + 1}. ${driver.fullName} - Entry: ${driver.queueEntryTime || driver.lastActiveTime} - Position: ${driver.queuePosition}`);
      });
      
      // Calculate stats
      const now = new Date();
      const totalWaitTimeMs = online.reduce((sum, driver) => {
        const queueEntryTime = driver.queueEntryTime || driver.lastActiveTime;
        if (queueEntryTime) {
          return sum + (now - new Date(queueEntryTime));
        }
        return sum;
      }, 0);
      
      const averageWaitTimeMinutes = online.length > 0 
        ? Math.floor(totalWaitTimeMs / (online.length * 60000)) 
        : 0;
      
      setQueueStats({
        total: driversData.length,
        online: online.length,
        engaged: engaged.length,
        offline: driversData.length - online.length - engaged.length,
        averageWaitTime: averageWaitTimeMinutes
      });
    } catch (err) {
      setError(err.error || 'Failed to fetch drivers');
    }
    setLoading(false);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchDrivers();
    setRefreshing(false);
    setSuccess('Queue refreshed successfully');
    setTimeout(() => setSuccess(''), 3000);
  };

  const handleValidateQueue = async () => {
    try {
      setLoading(true);
      const socket = getSocket();
      if (socket) {
        socket.emit('validateQueue');
        setSuccess('Queue validation requested - check server logs for results');
        setTimeout(() => setSuccess(''), 3000);
      } else {
        throw new Error('Socket not connected');
      }
    } catch (err) {
      setError('Failed to validate queue');
      setTimeout(() => setError(''), 3000);
    } finally {
      setLoading(false);
    }
  };

  // Fetch pending online requests
  const fetchPendingRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      const token = localStorage.getItem('adminToken');
      const response = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:5000/api'}/admin/online-requests`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();

      if (data.success) {
        // Full replacement from server - this is the source of truth
        const requests = data.requests || [];
        setPendingRequests(requests);
        setPendingRequestsCount(requests.length); // Use actual array length to keep in sync
      }
    } catch (err) {
      console.error('Error fetching pending requests:', err);
    } finally {
      setRequestsLoading(false);
    }
  }, []);

  // Fetch pending requests count (for badge)
  const fetchPendingRequestsCount = useCallback(async () => {
    try {
      const token = localStorage.getItem('adminToken');
      const response = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:5000/api'}/admin/online-requests/count`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();

      if (data.success) {
        setPendingRequestsCount(data.pendingCount || 0);
      }
    } catch (err) {
      console.error('Error fetching pending requests count:', err);
    }
  }, []);

  // Approve online request
  const handleApproveRequest = async (requestId) => {
    setProcessingRequestId(requestId);
    try {
      const socket = getSocket();
      if (socket) {
        // Use socket for real-time response
        socket.emit('approveOnlineRequest', { requestId });
      } else {
        // Fallback to REST API
        const token = localStorage.getItem('adminToken');
        const response = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:5000/api'}/admin/online-requests/${requestId}/approve`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        });
        const data = await response.json();

        if (data.success) {
          setSuccess(`${data.request?.driverName || 'Driver'} has been approved`);
          setPendingRequests(prev => prev.filter(r => r._id !== requestId));
          setPendingRequestsCount(prev => Math.max(0, prev - 1));
          fetchDrivers(); // Refresh queue
        } else {
          setError(data.message || 'Failed to approve request');
        }
      }
    } catch (err) {
      setError('Failed to approve request');
    } finally {
      setProcessingRequestId(null);
      setTimeout(() => { setError(''); setSuccess(''); }, 3000);
    }
  };

  // Reject online request
  const handleRejectRequest = async (requestId, reason = '') => {
    setProcessingRequestId(requestId);
    try {
      const socket = getSocket();
      if (socket) {
        // Use socket for real-time response
        socket.emit('rejectOnlineRequest', { requestId, reason });
      } else {
        // Fallback to REST API
        const token = localStorage.getItem('adminToken');
        const response = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:5000/api'}/admin/online-requests/${requestId}/reject`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ reason })
        });
        const data = await response.json();

        if (data.success) {
          setSuccess(`Request has been rejected`);
          setPendingRequests(prev => prev.filter(r => r._id !== requestId));
          setPendingRequestsCount(prev => Math.max(0, prev - 1));
        } else {
          setError(data.message || 'Failed to reject request');
        }
      }
    } catch (err) {
      setError('Failed to reject request');
    } finally {
      setProcessingRequestId(null);
      setTimeout(() => { setError(''); setSuccess(''); }, 3000);
    }
  };

  // Format time remaining for request expiry
  const formatTimeRemaining = (expiresAt) => {
    if (!expiresAt) return 'N/A';
    const remaining = Math.floor((new Date(expiresAt) - Date.now()) / 1000);
    if (remaining <= 0) return 'Expired';
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Remove driver from queue (Admin-Only Queue Management)
  // This directly removes the driver without waiting for a request
  const removeFromQueue = async (driverId, driverName) => {
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('adminRemoveFromQueue', {
          driverId,
          reason: 'Admin removed from queue'
        });
        // Success message handled by socket listener
      } else {
        throw new Error('Socket not connected');
      }
    } catch (err) {
      setError(err.error || 'Failed to remove driver from queue');
      setTimeout(() => setError(''), 3000);
    }
  };

  // Approve offline request
  const handleApproveOfflineRequest = async (requestId) => {
    try {
      setProcessingRequestId(requestId);
      const socket = getSocket();
      if (socket) {
        socket.emit('approveOfflineRequest', { requestId });
        // Success message handled by socket listener
      } else {
        throw new Error('Socket not connected');
      }
    } catch (err) {
      setError(err.error || 'Failed to approve offline request');
      setProcessingRequestId(null);
      setTimeout(() => setError(''), 3000);
    }
  };

  // Reject offline request
  const handleRejectOfflineRequest = async (requestId) => {
    try {
      setProcessingRequestId(requestId);
      const socket = getSocket();
      if (socket) {
        socket.emit('rejectOfflineRequest', { requestId, reason: 'Admin rejected' });
        // Success message handled by socket listener
      } else {
        throw new Error('Socket not connected');
      }
    } catch (err) {
      setError(err.error || 'Failed to reject offline request');
      setProcessingRequestId(null);
      setTimeout(() => setError(''), 3000);
    }
  };

  const formatTime = (timeString) => {
    if (!timeString) return 'N/A';
    try {
      return new Date(timeString).toLocaleTimeString();
    } catch {
      return 'N/A';
    }
  };

  const getTimeSince = (timeString) => {
    if (!timeString) return 'N/A';
    try {
      const now = new Date();
      const time = new Date(timeString);
      const diffMs = now - time;
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      return `${diffHours}h ${diffMins % 60}m ago`;
    } catch {
      return 'N/A';
    }
  };

  const getQueueWaitTime = (queueEntryTime) => {
    if (!queueEntryTime) return 'N/A';
    try {
      const now = new Date();
      const entryTime = new Date(queueEntryTime);
      const diffMs = now - entryTime;
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'Just joined';
      if (diffMins < 60) return `${diffMins}m in queue`;
      const diffHours = Math.floor(diffMins / 60);
      return `${diffHours}h ${diffMins % 60}m in queue`;
    } catch {
      return 'N/A';
    }
  };

  // Fetch pending requests count on mount and periodically
  useEffect(() => {
    fetchPendingRequestsCount();
    const interval = setInterval(fetchPendingRequestsCount, 30000);
    return () => clearInterval(interval);
  }, [fetchPendingRequestsCount]);

  // Fetch requests when switching to requests tab
  useEffect(() => {
    if (activeTab === 'requests') {
      fetchPendingRequests();
    }
  }, [activeTab, fetchPendingRequests]);

  // Auto-refresh requests list every 10 seconds when on requests tab
  useEffect(() => {
    if (activeTab === 'requests') {
      const interval = setInterval(fetchPendingRequests, 10000);
      return () => clearInterval(interval);
    }
  }, [activeTab, fetchPendingRequests]);

  // Cleanup socket listeners on unmount
  useEffect(() => {
    return () => {
      const socket = getSocket();
      if (socket) {
        socket.off('driverStatusUpdated');
        socket.off('driverOnline');
        socket.off('driverOffline');
        socket.off('queuePositionUpdated');
        socket.off('queuePositionsUpdated');
        socket.off('newOnlineRequest');
        socket.off('onlineRequestProcessed');
        socket.off('onlineRequestCancelled');
        socket.off('approveOnlineRequestResult');
        socket.off('rejectOnlineRequestResult');
        // Offline request listeners
        socket.off('newOfflineRequest');
        socket.off('offlineRequestProcessed');
        socket.off('approveOfflineRequestResult');
        socket.off('rejectOfflineRequestResult');
        socket.off('adminRemoveFromQueueResult');
      }
    };
  }, []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Queue Management</h1>
          <p className="text-gray-600 mt-1">
            Real-time driver queue monitoring and management
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            <FiRefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={handleValidateQueue}
            disabled={loading}
            className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            <FiList className="h-4 w-4" />
            <span>Validate Queue</span>
          </button>
        </div>
      </div>

      {/* Error/Success Messages */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium text-red-800">{error}</span>
          </div>
        </div>
      )}
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium text-green-800">{success}</span>
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <ModernCard>
          <div className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Total Drivers</p>
                <p className="text-2xl font-bold text-gray-900">{queueStats.total}</p>
              </div>
              <div className="p-3 bg-gray-100 rounded-lg">
                <FiUsers className="h-6 w-6 text-gray-600" />
              </div>
            </div>
          </div>
        </ModernCard>
        
        <ModernCard>
          <div className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Online</p>
                <p className="text-2xl font-bold text-green-600">{queueStats.online}</p>
              </div>
              <div className="p-3 bg-green-100 rounded-lg">
                <FiWifi className="h-6 w-6 text-green-600" />
              </div>
            </div>
          </div>
        </ModernCard>
        
        <ModernCard>
          <div className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Engaged</p>
                <p className="text-2xl font-bold text-orange-600">{queueStats.engaged || 0}</p>
              </div>
              <div className="p-3 bg-orange-100 rounded-lg">
                <span className="text-2xl">🚕</span>
              </div>
            </div>
          </div>
        </ModernCard>

        <ModernCard>
          <div className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Offline</p>
                <p className="text-2xl font-bold text-gray-600">{queueStats.offline}</p>
              </div>
              <div className="p-3 bg-gray-100 rounded-lg">
                <FiWifiOff className="h-6 w-6 text-gray-600" />
              </div>
            </div>
          </div>
        </ModernCard>
        
        <ModernCard>
          <div className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">Avg Queue Wait</p>
                <p className="text-2xl font-bold text-orange-600">{queueStats.averageWaitTime}m</p>
              </div>
              <div className="p-3 bg-orange-100 rounded-lg">
                <FiList className="h-6 w-6 text-orange-600" />
              </div>
            </div>
          </div>
        </ModernCard>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab('queue')}
            className={`py-4 px-1 border-b-2 font-medium text-sm ${
              activeTab === 'queue'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <FiUsers className="inline-block mr-2 h-4 w-4" />
            Queue
          </button>
          <button
            onClick={() => setActiveTab('requests')}
            className={`py-4 px-1 border-b-2 font-medium text-sm relative ${
              activeTab === 'requests'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <FiBell className="inline-block mr-2 h-4 w-4" />
            Requests
            {(pendingRequestsCount + pendingOfflineRequestsCount) > 0 && (
              <span className="absolute -top-1 -right-2 inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-white transform translate-x-1/2 bg-red-500 rounded-full">
                {pendingRequestsCount + pendingOfflineRequestsCount}
              </span>
            )}
          </button>
        </nav>
      </div>

      {/* Queue Tab Content */}
      {activeTab === 'queue' && (
        <>
          {/* Queue Analytics */}
          <ModernCard>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Queue Analytics</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-blue-50 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-blue-600">Next in Queue</p>
                  <p className="text-lg font-bold text-blue-900">
                    {onlineDrivers.length > 0 ? onlineDrivers[0]?.fullName || 'Unknown' : 'No drivers'}
                  </p>
                </div>
                <div className="text-blue-600">
                  <FiUser className="h-8 w-8" />
                </div>
              </div>
            </div>
            <div className="bg-green-50 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-green-600">Queue Efficiency</p>
                  <p className="text-lg font-bold text-green-900">
                    {queueStats.averageWaitTime < 10 ? 'Excellent' : 
                     queueStats.averageWaitTime < 20 ? 'Good' : 'Needs Attention'}
                  </p>
                </div>
                <div className="text-green-600">
                  <FiClock className="h-8 w-8" />
                </div>
              </div>
            </div>
            <div className="bg-orange-50 rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-orange-600">Longest Wait</p>
                  <p className="text-lg font-bold text-orange-900">
                    {onlineDrivers.length > 0 ? 
                      getQueueWaitTime(onlineDrivers[onlineDrivers.length - 1]?.queueEntryTime) : 
                      'N/A'}
                  </p>
                </div>
                <div className="text-orange-600">
                  <FiArrowUp className="h-8 w-8" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </ModernCard>

      {/* Queue List */}
      <ModernCard>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-6 flex items-center">
            <FiWifi className="mr-2 text-green-600" />
            Live Queue - Online Drivers ({onlineDrivers.length})
            <span className="ml-3 text-sm font-normal text-blue-600 bg-blue-50 px-2 py-1 rounded">
              First Come, First Served
            </span>
          </h2>
          
          {/* Engaged Drivers Section */}
          {engagedDrivers.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-orange-700 mb-3 flex items-center">
                <span className="mr-2">🚕</span> Engaged Drivers ({engagedDrivers.length})
              </h3>
              <div className="space-y-2">
                {engagedDrivers.map((driver) => (
                  <div
                    key={driver._id}
                    className="flex items-center justify-between p-3 rounded-lg border-2 border-orange-200 bg-orange-50"
                  >
                    <div className="flex items-center space-x-3">
                      <div className="flex items-center justify-center w-8 h-8 rounded-full bg-orange-500 text-white text-xs font-bold">
                        🚕
                      </div>
                      {driver.driverSelfie ? (
                        <img
                          src={getImageUrl(driver.driverSelfie)}
                          alt={driver.fullName}
                          className="w-10 h-10 rounded-full object-cover border-2 border-orange-300"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-full bg-orange-200 flex items-center justify-center">
                          <FiUser className="text-orange-600" />
                        </div>
                      )}
                      <div>
                        <div className="text-sm font-medium text-gray-900">{driver.fullName}</div>
                        <div className="text-xs text-gray-500 flex items-center">
                          <FiPhone className="mr-1" /> {driver.mobileNo}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="px-3 py-1 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                        ENGAGED
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Queue List */}
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-500">Loading queue...</p>
            </div>
          ) : onlineDrivers.length === 0 && engagedDrivers.length === 0 ? (
            <div className="text-center py-12">
              <FiWifiOff className="h-16 w-16 text-gray-400 mx-auto mb-4" />
              <p className="text-lg font-medium text-gray-900">No drivers online</p>
              <p className="text-gray-500">Drivers will appear here when they go online</p>
            </div>
          ) : (
            <div className="space-y-4">
              {onlineDrivers.map((driver, index) => (
                <div 
                  key={driver._id} 
                  className={`flex items-center justify-between p-4 rounded-lg border-2 transition-colors ${
                    index === 0 
                      ? 'border-green-200 bg-green-50' 
                      : 'border-gray-200 bg-gray-50'
                  }`}
                >
                  <div className="flex items-center space-x-4">
                    {/* Queue Position */}
                    <div className="flex-shrink-0">
                      <div className={`flex items-center justify-center w-10 h-10 rounded-full text-sm font-bold ${
                        index === 0 
                          ? 'bg-green-600 text-white' 
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {driver.queuePosition || index + 1}
                      </div>
                    </div>
                    
                    {/* Driver Info */}
                    <div className="flex items-center space-x-3">
                      {driver.driverSelfie ? (
                        <img 
                          src={getImageUrl(driver.driverSelfie)} 
                          alt={driver.fullName} 
                          className="w-12 h-12 rounded-full object-cover border-2 border-gray-200"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center">
                          <FiUser className="text-gray-400" />
                        </div>
                      )}
                      <div>
                        <div className="text-sm font-medium text-gray-900">{driver.fullName}</div>
                        <div className="text-xs text-gray-500 flex items-center space-x-3">
                          <span className="flex items-center">
                            <FiPhone className="mr-1" /> {driver.mobileNo}
                          </span>
                          {!isExecutive && (
                            <span className="flex items-center">
                              <FiMapPin className="mr-1" /> {driver.currentPickupLocation || 'No location'}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    {/* Vehicle Info */}
                    <div className="hidden md:block">
                      <div className="text-sm font-medium text-gray-900">{driver.vehicleNo}</div>
                      <div className="text-xs text-gray-500">{driver.vehicleType || 'N/A'}</div>
                    </div>

                    {/* Queue Entry Time */}
                    <div className="hidden lg:block">
                      <div className="text-sm font-medium text-blue-600">
                        Joined: {formatTime(driver.queueEntryTime || driver.lastActiveTime)}
                      </div>
                      <div className="text-xs text-blue-500">
                        {getQueueWaitTime(driver.queueEntryTime || driver.lastActiveTime)}
                      </div>
                    </div>
                  </div>
                  
                  {/* Status and Actions */}
                  <div className="flex items-center space-x-4">
                    <div className="text-right">
                      <div className="text-sm text-gray-500">
                        Online: {formatTime(driver.lastActiveTime)}
                      </div>
                      <div className="text-xs text-gray-400">
                        {getTimeSince(driver.lastActiveTime)}
                      </div>
                      <div className="text-xs text-blue-600 font-medium">
                        Queue: {getQueueWaitTime(driver.queueEntryTime || driver.lastActiveTime)}
                      </div>
                    </div>
                    
                    <div className="flex flex-col items-end space-y-2">
                      {/* Three-state connection status */}
                      <div className="flex items-center space-x-2">
                        {driver.connectionStatus === 'connected' || (driver.isOnline && !driver.connectionStatus) ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                            🟢 Online
                          </span>
                        ) : driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue) ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                            ⚠️ Not Reachable
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                            ⚫ Offline
                          </span>
                        )}

                        <button
                          onClick={() => removeFromQueue(driver._id, driver.fullName)}
                          className="px-3 py-1 text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200 rounded transition-colors"
                          title="Remove from Queue"
                        >
                          Remove from Queue
                        </button>
                      </div>

                      {/* Last seen time for Not Reachable drivers */}
                      {(driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue)) && driver.lastActiveTime && (
                        <p className="text-xs text-yellow-700">
                          Last seen: {(() => {
                            const lastSeen = new Date(driver.lastActiveTime);
                            const now = new Date();
                            const diffMinutes = Math.floor((now - lastSeen) / 60000);
                            if (diffMinutes < 1) return 'Just now';
                            if (diffMinutes < 60) return `${diffMinutes} min ago`;
                            const diffHours = Math.floor(diffMinutes / 60);
                            return `${diffHours}h ${diffMinutes % 60}m ago`;
                          })()}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ModernCard>
        </>
      )}

      {/* Requests Tab Content */}
      {activeTab === 'requests' && (
        <div className="space-y-6">
          {/* Online Requests Section */}
          <ModernCard>
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center">
                  <FiBell className="mr-2 text-green-600" />
                  Online Requests ({pendingRequestsCount})
                </h2>
                <button
                  onClick={fetchPendingRequests}
                  disabled={requestsLoading}
                  className="flex items-center space-x-2 px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors disabled:opacity-50"
                >
                  <FiRefreshCw className={`h-4 w-4 ${requestsLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh</span>
                </button>
              </div>

              {requestsLoading && pendingRequests.length === 0 ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
                  <p className="text-gray-500">Loading requests...</p>
                </div>
              ) : pendingRequests.length === 0 ? (
                <div className="text-center py-8">
                  <FiCheckCircle className="h-12 w-12 text-green-400 mx-auto mb-3" />
                  <p className="text-base font-medium text-gray-900">No pending online requests</p>
                  <p className="text-sm text-gray-500">All driver online requests have been processed</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {pendingRequests.map((request) => (
                    <div
                      key={request._id}
                      className="flex items-center justify-between p-4 rounded-lg border-2 border-green-200 bg-green-50"
                    >
                      <div className="flex items-center space-x-4">
                        {/* Driver Photo */}
                        {request.driverPhoto ? (
                          <img
                            src={getImageUrl(request.driverPhoto)}
                            alt={request.driverName}
                            className="w-14 h-14 rounded-full object-cover border-2 border-green-300"
                          />
                        ) : (
                          <div className="w-14 h-14 rounded-full bg-green-200 flex items-center justify-center">
                            <FiUser className="text-green-600 h-6 w-6" />
                          </div>
                        )}

                        {/* Driver Info */}
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="text-base font-semibold text-gray-900">{request.driverName}</span>
                            <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800 rounded">
                              Wants to GO ONLINE
                            </span>
                          </div>
                          <div className="text-sm text-gray-600 flex items-center space-x-4">
                            <span className="flex items-center">
                              <FiPhone className="mr-1 h-3 w-3" /> {request.driverPhone}
                            </span>
                            {!isExecutive && (
                              <span className="flex items-center">
                                <FiMapPin className="mr-1 h-3 w-3" /> {request.boothName}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            <span className="bg-gray-200 px-2 py-0.5 rounded">{request.vehicleType}</span>
                            <span className="ml-2">
                              Requested: {new Date(request.requestedAt).toLocaleTimeString()}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col items-end space-y-2">
                        {/* Timer */}
                        <div className="text-sm text-orange-600 font-medium flex items-center">
                          <FiClock className="mr-1 h-4 w-4" />
                          Expires in: {formatTimeRemaining(request.expiresAt)}
                        </div>

                        {/* Buttons */}
                        <div className="flex space-x-2">
                          <button
                            onClick={() => handleApproveRequest(request._id)}
                            disabled={processingRequestId === request._id}
                            className="flex items-center space-x-1 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                          >
                            <FiCheckCircle className="h-4 w-4" />
                            <span>{processingRequestId === request._id ? 'Processing...' : 'Approve'}</span>
                          </button>
                          <button
                            onClick={() => handleRejectRequest(request._id)}
                            disabled={processingRequestId === request._id}
                            className="flex items-center space-x-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                          >
                            <FiXCircle className="h-4 w-4" />
                            <span>Reject</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ModernCard>

          {/* Offline Requests Section */}
          <ModernCard>
            <div className="p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900 flex items-center">
                  <FiBell className="mr-2 text-red-600" />
                  Offline Requests ({pendingOfflineRequestsCount})
                </h2>
              </div>

              {pendingOfflineRequests.length === 0 ? (
                <div className="text-center py-8">
                  <FiCheckCircle className="h-12 w-12 text-green-400 mx-auto mb-3" />
                  <p className="text-base font-medium text-gray-900">No pending offline requests</p>
                  <p className="text-sm text-gray-500">All driver offline requests have been processed</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {pendingOfflineRequests.map((request) => (
                    <div
                      key={request._id}
                      className="flex items-center justify-between p-4 rounded-lg border-2 border-red-200 bg-red-50"
                    >
                      <div className="flex items-center space-x-4">
                        {/* Driver Icon */}
                        <div className="w-14 h-14 rounded-full bg-red-200 flex items-center justify-center">
                          <FiUser className="text-red-600 h-6 w-6" />
                        </div>

                        {/* Driver Info */}
                        <div>
                          <div className="flex items-center space-x-2">
                            <span className="text-base font-semibold text-gray-900">{request.driverName}</span>
                            <span className="px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800 rounded">
                              Wants to GO OFFLINE
                            </span>
                          </div>
                          <div className="text-sm text-gray-600 flex items-center space-x-4">
                            <span className="flex items-center">
                              <FiPhone className="mr-1 h-3 w-3" /> {request.driverPhone}
                            </span>
                            {request.boothName && !isExecutive && (
                              <span className="flex items-center">
                                <FiMapPin className="mr-1 h-3 w-3" /> {request.boothName}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-500 mt-1">
                            {request.queuePosition && (
                              <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded mr-2">
                                Queue #{request.queuePosition}
                              </span>
                            )}
                            <span>
                              Requested: {new Date(request.requestedAt).toLocaleTimeString()}
                            </span>
                          </div>
                          {request.reason && (
                            <p className="text-xs text-gray-600 mt-1 italic">Reason: {request.reason}</p>
                          )}
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col items-end space-y-2">
                        {/* Timer */}
                        <div className="text-sm text-orange-600 font-medium flex items-center">
                          <FiClock className="mr-1 h-4 w-4" />
                          Expires in: {formatTimeRemaining(request.expiresAt)}
                        </div>

                        {/* Buttons */}
                        <div className="flex space-x-2">
                          <button
                            onClick={() => handleApproveOfflineRequest(request._id)}
                            disabled={processingRequestId === request._id}
                            className="flex items-center space-x-1 px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                          >
                            <FiCheckCircle className="h-4 w-4" />
                            <span>{processingRequestId === request._id ? 'Processing...' : 'Approve'}</span>
                          </button>
                          <button
                            onClick={() => handleRejectOfflineRequest(request._id)}
                            disabled={processingRequestId === request._id}
                            className="flex items-center space-x-1 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                          >
                            <FiXCircle className="h-4 w-4" />
                            <span>Reject</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ModernCard>

          {/* Info Note */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm text-blue-800">
              <strong>Admin-Only Queue Management:</strong> Drivers must request to go online or offline, and you must approve.
              You can also directly remove drivers from the queue using the "Remove from Queue" button in the Queue tab.
              Requests expire after some time if not processed.
            </p>
          </div>
        </div>
      )}

      {/* Notification sound */}
      <audio ref={audioRef} preload="auto">
        <source src="/notification.mp3" type="audio/mpeg" />
        <source src="/notification.wav" type="audio/wav" />
      </audio>
    </div>
  );
};

export default QueueManagement;