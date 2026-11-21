import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  FaMapMarkerAlt, 
  FaUser, 
  FaPhone, 
  FaPowerOff,
  FaWifi,
  FaExclamationTriangle,
  FaSignOutAlt,
  FaWallet,
  FaCar,
  FaCheckCircle,
  FaHistory,
  FaChevronDown,
  FaChevronUp,
  FaClock,
  FaRoute,
  FaTimes
} from 'react-icons/fa';

// Import services and hooks
import {
  initializeSocket,
  getSocket,
  isSocketConnected,
  subscribeToDriverUpdates,
  unsubscribeFromDriverUpdates,
  driverGoOnline,
  driverGoOffline,
  driverAcceptRide,
  verifyStartOTP,
  verifyEndOTP,
  cancelRide
} from '../../../services/socket';
import { useDriverState } from '../../../contexts/DriverStateContext';
import { drivers } from '../../../services/api';
import MapNavigationPanel from '../MapNavigationPanel';
import { openGoogleMapsNavigation } from '../../../services/mapNavigationService';

const ModernDriverDashboard = () => {
  // NOTE: Removed excessive console.log that was running on every re-render
  const navigate = useNavigate();
  
  // State from context
  const {
    driver,
    socket,
    socketConnected,
    isOnline,
    queuePosition,
    activeRide,
    rideRequests,
    actions
  } = useDriverState();

  // Local state
  const [currentView, setCurrentView] = useState('dashboard');
  const [isLoading, setIsLoading] = useState(false);
  const [rideStage, setRideStage] = useState('assigned');
  const [assignedRides, setAssignedRides] = useState([]);
  const [earnings, setEarnings] = useState(0);
  const [tripsToday, setTripsToday] = useState(0);
  const [showBottomSheet, setShowBottomSheet] = useState(false);
  const [showOTPInput, setShowOTPInput] = useState(false);
  const [otpInput, setOtpInput] = useState('');
  const [selectedRide, setSelectedRide] = useState(null);
  const [windowWidth, setWindowWidth] = useState(window.innerWidth);
  
  // Ride history state
  const [rideHistory, setRideHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showCompletionAnimation, setShowCompletionAnimation] = useState(false);
  const [completedRideDetails, setCompletedRideDetails] = useState(null);

  // Profile section toggle state
  const [showProfile, setShowProfile] = useState(false);

  // Map navigation panel state
  const [showMapPanel, setShowMapPanel] = useState(false);

  // Pending approval state (for online request workflow)
  const [pendingApproval, setPendingApproval] = useState(false);
  const [pendingRequestId, setPendingRequestId] = useState(null);
  const [pendingExpiresAt, setPendingExpiresAt] = useState(null);
  const [pendingTimeRemaining, setPendingTimeRemaining] = useState(null);

  // Pending OFFLINE approval state (mirrors online flow)
  const [pendingOfflineApproval, setPendingOfflineApproval] = useState(false);
  // eslint-disable-next-line no-unused-vars
  const [pendingOfflineRequestId, setPendingOfflineRequestId] = useState(null);
  const [pendingOfflineExpiresAt, setPendingOfflineExpiresAt] = useState(null);
  const [pendingOfflineTimeRemaining, setPendingOfflineTimeRemaining] = useState(null);

  // Rejection message state (for showing persistent feedback)
  const [rejectionMessage, setRejectionMessage] = useState(null);

  // Manual booking timer state - tracks remaining seconds for each manual booking request
  const [manualBookingTimers, setManualBookingTimers] = useState({});

  // Debounce ref for "Go Online" button (prevents rapid multiple requests)
  const isRequestingRef = useRef(false);

  // Window resize listener
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const isMobile = windowWidth < 768;

  // Countdown timer for pending approval
  useEffect(() => {
    if (pendingApproval && pendingExpiresAt) {
      const updateTimer = () => {
        const now = new Date().getTime();
        const expiresTime = new Date(pendingExpiresAt).getTime();
        const remaining = Math.max(0, Math.floor((expiresTime - now) / 1000));

        if (remaining <= 0) {
          // Request expired
          setPendingApproval(false);
          setPendingRequestId(null);
          setPendingExpiresAt(null);
          setPendingTimeRemaining(null);
          // Reset debounce ref so driver can try again
          isRequestingRef.current = false;
          console.log('[ModernDriverDashboard] Online request expired');
        } else {
          const minutes = Math.floor(remaining / 60);
          const seconds = remaining % 60;
          setPendingTimeRemaining(`${minutes}:${seconds.toString().padStart(2, '0')}`);
        }
      };

      updateTimer();
      const interval = setInterval(updateTimer, 1000);
      return () => clearInterval(interval);
    }
  }, [pendingApproval, pendingExpiresAt]);

  // Countdown timer for pending OFFLINE approval
  useEffect(() => {
    if (pendingOfflineApproval && pendingOfflineExpiresAt) {
      const updateTimer = () => {
        const now = new Date().getTime();
        const expiresTime = new Date(pendingOfflineExpiresAt).getTime();
        const remaining = Math.max(0, Math.floor((expiresTime - now) / 1000));

        if (remaining <= 0) {
          // Request expired
          setPendingOfflineApproval(false);
          setPendingOfflineRequestId(null);
          setPendingOfflineExpiresAt(null);
          setPendingOfflineTimeRemaining(null);
          // Reset debounce ref so driver can try again
          isRequestingRef.current = false;
          console.log('[ModernDriverDashboard] Offline request expired');
        } else {
          const minutes = Math.floor(remaining / 60);
          const seconds = remaining % 60;
          setPendingOfflineTimeRemaining(`${minutes}:${seconds.toString().padStart(2, '0')}`);
        }
      };

      updateTimer();
      const interval = setInterval(updateTimer, 1000);
      return () => clearInterval(interval);
    }
  }, [pendingOfflineApproval, pendingOfflineExpiresAt]);

  // Countdown timer for manual booking requests
  // Updates every second and auto-removes expired requests
  useEffect(() => {
    // Get all manual booking rides with expiresAt
    const manualBookings = assignedRides.filter(
      ride => ride.isManualBooking && ride.expiresAt
    );

    if (manualBookings.length === 0) {
      setManualBookingTimers({});
      return;
    }

    const updateTimers = () => {
      const now = Date.now();
      const newTimers = {};
      const expiredRideIds = [];

      manualBookings.forEach(ride => {
        const expiresTime = new Date(ride.expiresAt).getTime();
        const remaining = Math.max(0, Math.floor((expiresTime - now) / 1000));

        if (remaining <= 0) {
          // Mark as expired for removal
          expiredRideIds.push(ride._id);
          console.log(`[ModernDriverDashboard] Manual booking ${ride.bookingId || ride._id} expired`);
        } else {
          newTimers[ride._id] = remaining;
        }
      });

      setManualBookingTimers(newTimers);

      // Remove expired rides from the list
      if (expiredRideIds.length > 0) {
        setAssignedRides(prev => prev.filter(r => !expiredRideIds.includes(r._id)));
      }
    };

    // Run immediately
    updateTimers();

    // Update every second
    const interval = setInterval(updateTimers, 1000);

    return () => clearInterval(interval);
  }, [assignedRides]);

  // Persist pending approval state to localStorage
  useEffect(() => {
    if (pendingApproval && pendingRequestId) {
      localStorage.setItem('PENDING_APPROVAL', JSON.stringify({
        pending: true,
        requestId: pendingRequestId,
        expiresAt: pendingExpiresAt
      }));
      console.log('[ModernDriverDashboard] Saved pending approval to localStorage');
    } else if (!pendingApproval) {
      localStorage.removeItem('PENDING_APPROVAL');
    }
  }, [pendingApproval, pendingRequestId, pendingExpiresAt]);

  // Check for pending approval on mount
  useEffect(() => {
    const checkPendingApprovalOnMount = async () => {
      const savedPending = localStorage.getItem('PENDING_APPROVAL');
      if (savedPending) {
        try {
          const pendingData = JSON.parse(savedPending);
          console.log('[ModernDriverDashboard] Found saved pending approval:', pendingData);

          // Check if still pending on server
          const response = await drivers.checkOnlineRequestStatus();
          console.log('[ModernDriverDashboard] Server response for pending:', response);

          if (response.success && response.data) {
            const status = response.data.status;

            if (status === 'pending') {
              // Restore pending state
              console.log('[ModernDriverDashboard] Restoring pending approval state');
              setPendingApproval(true);
              setPendingRequestId(pendingData.requestId);
              setPendingExpiresAt(pendingData.expiresAt);
            } else if (status === 'approved') {
              // Request was approved while app was closed
              console.log('[ModernDriverDashboard] Request was approved - setting online');
              localStorage.removeItem('PENDING_APPROVAL');
              actions.setOnlineStatus(true);
              actions.setQueuePosition(response.data.queuePosition);
            } else {
              // Expired, rejected, or cancelled
              console.log('[ModernDriverDashboard] Request is no longer pending:', status);
              localStorage.removeItem('PENDING_APPROVAL');
            }
          } else if (response.data?.status === 'none') {
            // No pending request found on server
            console.log('[ModernDriverDashboard] No pending request on server');
            localStorage.removeItem('PENDING_APPROVAL');
          }
        } catch (error) {
          console.error('[ModernDriverDashboard] Error checking pending approval:', error);
          localStorage.removeItem('PENDING_APPROVAL');
        }
      }
    };

    if (driver && socketConnected) {
      checkPendingApprovalOnMount();
    }
  }, [driver, socketConnected]);

  // Get driver's earnings — driverFare is the authoritative field (set by piecewise formula)
  const getDriverEarnings = (ride) => {
    // Priority 1: driverFare — always set on new rides
    if (ride.driverFare && ride.driverFare > 0) {
      return ride.driverFare;
    }
    // Priority 2: legacy fare field (old rides where fare = driver earnings)
    if (ride.fare && ride.fare > 0) {
      return ride.fare;
    }
    // Priority 3: estimatedFare as-is (very old rides)
    if (ride.estimatedFare && ride.estimatedFare > 0) {
      return ride.estimatedFare;
    }
    if (ride.actualFare && ride.actualFare > 0) {
      return ride.actualFare;
    }
    return 0;
  };

  // Load driver data on mount and recover active ride if needed
  useEffect(() => {
    console.log('🚀 ModernDriverDashboard Component Loaded - New UI Active!');
    
    const driverData = localStorage.getItem('driver');
    if (driverData && !driver) {
      try {
        const parsedDriver = JSON.parse(driverData);
        console.log('[ModernDriverDashboard] Loading driver data:', parsedDriver);
        actions.setDriver(parsedDriver);
      } catch (error) {
        console.error('[ModernDriverDashboard] Error parsing driver data:', error);
      }
    }
    
    // Check if we need to recover active ride from backup
    if (!activeRide || !activeRide._id) {
      try {
        const backupRide = localStorage.getItem('driver_active_ride_backup');
        if (backupRide) {
          const recoveredRide = JSON.parse(backupRide);
          console.log('[ModernDriverDashboard] Recovering active ride from backup:', recoveredRide);
          
          // Verify the ride has OTP data
          if (recoveredRide._id && (recoveredRide.startOTP || recoveredRide.endOTP)) {
            actions.setActiveRide(recoveredRide);
            setRideStage(recoveredRide.status === 'started' ? 'started' : 'assigned');
            console.log('[ModernDriverDashboard] Active ride recovered successfully with OTPs');
          }
        }
      } catch (error) {
        console.error('[ModernDriverDashboard] Failed to recover active ride:', error);
      }
    } else if (activeRide && (!activeRide.startOTP && !activeRide.endOTP)) {
      // Active ride exists but missing OTP data, try to restore from backup
      try {
        const backupRide = localStorage.getItem('driver_active_ride_backup');
        if (backupRide) {
          const recoveredRide = JSON.parse(backupRide);
          if (recoveredRide._id === activeRide._id && (recoveredRide.startOTP || recoveredRide.endOTP)) {
            console.log('[ModernDriverDashboard] Restoring missing OTP data from backup');
            actions.setActiveRide(recoveredRide);
          }
        }
      } catch (error) {
        console.error('[ModernDriverDashboard] Failed to restore OTP data:', error);
      }
    }
  }, []);

  // Fetch pending rides on component mount
  useEffect(() => {
    const fetchPendingRides = async () => {
      const token = localStorage.getItem('driverToken');
      if (token && !activeRide) {  // Only fetch if no active ride
        try {
          console.log('[ModernDriverDashboard] Fetching pending rides...');
          const result = await drivers.getPendingRides();

          if (result.success && result.data && result.data.rides) {
            console.log('[ModernDriverDashboard] Fetched pending rides:', result.data.rides);

            // Format rides to match our component structure
            const formattedRides = result.data.rides.map(ride => ({
              _id: ride._id || ride.rideId,
              rideId: ride.rideId,
              bookingId: ride.bookingId,
              userName: ride.userName,
              userPhone: ride.userPhone,
              pickupLocation: ride.pickupLocation,
              dropLocation: ride.dropLocation,
              vehicleType: ride.vehicleType,
              distance: ride.distance,
              driverFare: ride.driverFare,  // Store actual driver fare
              fare: ride.driverFare || getDriverEarnings(ride),  // Driver sees their earnings
              estimatedFare: ride.driverFare || getDriverEarnings(ride),  // Use driver fare
              startOTP: ride.startOTP || null,
              endOTP: ride.endOTP || null,
              status: 'pending',
              isManualBooking: ride.isManualBooking || ride.bookingSource === 'manual',
              bookingSource: ride.bookingSource || 'app',
              expiresAt: ride.expiresAt || null  // For manual booking countdown timer
            }));

            // Only set rides if we have any
            if (formattedRides.length > 0) {
              setAssignedRides(formattedRides);
              console.log(`[ModernDriverDashboard] Loaded ${formattedRides.length} pending rides`);
            }
          }
        } catch (error) {
          console.error('[ModernDriverDashboard] Error fetching pending rides:', error);
        }
      }
    };

    // Fetch pending rides after a slight delay to ensure socket is ready
    const timer = setTimeout(fetchPendingRides, 500);
    return () => clearTimeout(timer);
  }, [activeRide]);  // Re-fetch if activeRide changes

  // Initialize socket connection
  useEffect(() => {
    const initSocket = async () => {
      const token = localStorage.getItem('driverToken');
      if (token && !socket) {
        try {
          const socketInstance = await initializeSocket(token);
          actions.setSocket(socketInstance);
          actions.setSocketConnected(true);
        } catch (error) {
          console.error('Socket initialization error:', error);
          actions.setSocketConnected(false);
        }
      }
    };

    initSocket();
  }, []);

  // Page Visibility API handler for mobile reconnection
  // Detects when app comes back to foreground and reconnects socket if needed
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible') {
        console.log('[ModernDriverDashboard] 📱 Page became visible - checking connection...');

        // Check if socket needs reconnection
        const currentSocket = getSocket();
        const isConnected = isSocketConnected();

        console.log('[ModernDriverDashboard] 📱 Connection check:', {
          hasSocket: !!currentSocket,
          socketConnected: isConnected,
          contextConnected: socketConnected
        });

        if (!currentSocket || !isConnected) {
          // Socket is disconnected - reinitialize
          console.log('[ModernDriverDashboard] 📱 Reconnecting socket...');
          const token = localStorage.getItem('driverToken');
          if (token) {
            try {
              const newSocket = await initializeSocket(token);
              if (newSocket) {
                actions.setSocket(newSocket);
                actions.setSocketConnected(true);
                console.log('[ModernDriverDashboard] 📱 Socket reconnected successfully');

                // Re-emit rejoin event
                const driverData = localStorage.getItem('driver');
                if (driverData) {
                  const driverInfo = JSON.parse(driverData);
                  newSocket.emit('driverRoomRejoin', {
                    driverId: driverInfo._id || driverInfo.id,
                    driverName: driverInfo.fullName || driverInfo.name,
                    timestamp: new Date().toISOString(),
                    reconnectReason: 'page_visibility'
                  });
                }

                // PART 9 FIX: Refetch pending rides after reconnection
                // Server will send via socket, but also fetch via API as fallback
                setTimeout(async () => {
                  try {
                    console.log('[ModernDriverDashboard] 📱 Refetching pending rides after reconnect...');
                    const result = await drivers.getPendingRides();
                    if (result.success && result.data?.rides?.length > 0) {
                      const formattedRides = result.data.rides.map(ride => ({
                        _id: ride._id || ride.rideId,
                        rideId: ride.rideId,
                        bookingId: ride.bookingId,
                        userName: ride.userName,
                        userPhone: ride.userPhone,
                        pickupLocation: ride.pickupLocation,
                        dropLocation: ride.dropLocation,
                        vehicleType: ride.vehicleType,
                        distance: ride.distance,
                        driverFare: ride.driverFare,
                        fare: ride.driverFare || getDriverEarnings(ride),
                        estimatedFare: ride.driverFare || getDriverEarnings(ride),
                        startOTP: ride.startOTP || null,
                        endOTP: ride.endOTP || null,
                        status: 'pending',
                        isManualBooking: ride.isManualBooking || ride.bookingSource === 'manual',
                        bookingSource: ride.bookingSource || 'app',
                        expiresAt: ride.expiresAt || null
                      }));

                      // Merge without duplicates
                      setAssignedRides(prev => {
                        const existingIds = new Set(prev.map(r => r._id?.toString()));
                        const newRides = formattedRides.filter(r => !existingIds.has(r._id?.toString()));
                        if (newRides.length > 0) {
                          console.log(`[ModernDriverDashboard] 📱 Added ${newRides.length} pending rides after reconnect`);
                          return [...newRides, ...prev];
                        }
                        return prev;
                      });
                    }
                  } catch (fetchError) {
                    console.error('[ModernDriverDashboard] 📱 Error refetching rides:', fetchError);
                  }
                }, 1000);  // Small delay to let socket rejoin complete
              }
            } catch (error) {
              console.error('[ModernDriverDashboard] 📱 Reconnection failed:', error);
              actions.setSocketConnected(false);
            }
          }
        } else if (isConnected && !socketConnected) {
          // Socket is connected but context state is wrong - fix it
          console.log('[ModernDriverDashboard] 📱 Fixing socket connected state mismatch');
          actions.setSocketConnected(true);

          // Also emit rejoin to ensure server knows we're back
          const driverData = localStorage.getItem('driver');
          if (driverData && currentSocket) {
            const driverInfo = JSON.parse(driverData);
            currentSocket.emit('driverRoomRejoin', {
              driverId: driverInfo._id || driverInfo.id,
              driverName: driverInfo.fullName || driverInfo.name,
              timestamp: new Date().toISOString(),
              reconnectReason: 'state_sync'
            });
          }
        }
      }
    };

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Also handle when page shows (for mobile browsers)
    window.addEventListener('pageshow', handleVisibilityChange);

    // Initial check on mount (in case page was backgrounded before component mounted)
    if (document.visibilityState === 'visible') {
      // Small delay to let other effects run first
      setTimeout(handleVisibilityChange, 1000);
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
    };
  }, [socketConnected, actions]);

  // Periodic connection health check (every 30 seconds)
  // Syncs socket state with React context state
  useEffect(() => {
    const healthCheck = () => {
      const currentSocket = getSocket();
      const isConnected = isSocketConnected();

      // If context says connected but socket is not, fix it
      if (socketConnected && (!currentSocket || !isConnected)) {
        console.log('[ModernDriverDashboard] 🔍 Health check: Socket disconnected, updating state');
        actions.setSocketConnected(false);
      }
      // If context says disconnected but socket is connected, fix it
      else if (!socketConnected && currentSocket && isConnected) {
        console.log('[ModernDriverDashboard] 🔍 Health check: Socket connected, updating state');
        actions.setSocketConnected(true);
      }
    };

    const interval = setInterval(healthCheck, 30000);
    return () => clearInterval(interval);
  }, [socketConnected, actions]);

  // Subscribe to driver updates
  useEffect(() => {
    if (socket && socketConnected) {
      const callbacks = {
        onNewRideRequest: (data) => {
          console.log('[ModernDriverDashboard] New ride request:', data);
          console.log('[ModernDriverDashboard] Full ride data:', JSON.stringify(data, null, 2));
          
          // Production debugging
          if (window.location.hostname !== 'localhost') {
            console.log('[PRODUCTION] New ride fields:', {
              hasStartOTP: !!data.startOTP,
              hasEndOTP: !!data.endOTP,
              startOTP: data.startOTP,
              endOTP: data.endOTP,
              driverFare: data.driverFare, // Driver's base earnings only
              distance: data.distance,
              vehicleType: data.vehicleType
            });
          }

          // Debug fare fields
          console.log('[driverFare Debug] All fare fields from socket:', {
            driverFare: data.driverFare,
            fare: data.fare,
            estimatedFare: data.estimatedFare,
            customerFare: data.customerFare,
            baseFare: data.baseFare,
            types: {
              driverFare: typeof data.driverFare,
              fare: typeof data.fare,
              estimatedFare: typeof data.estimatedFare
            }
          });
          
          // All bookings (including manual) now require driver acceptance
          // No skipping - handle all ride requests the same way
          
          // Create ride object similar to SimplifiedDashboard
          const newRide = {
            _id: data._id || data.rideId,
            rideId: data.rideId,
            bookingId: data.bookingId,
            userName: data.userName,
            userPhone: data.userPhone,
            pickupLocation: data.pickupLocation,
            dropLocation: data.dropLocation,
            vehicleType: data.vehicleType,
            distance: data.distance,
            driverFare: data.driverFare,  // Store actual driver fare from backend
            fare: data.driverFare || getDriverEarnings(data),  // Use driverFare or fallback to calculation
            estimatedFare: data.driverFare || getDriverEarnings(data),  // Use driverFare or fallback to calculation
            startOTP: data.startOTP || null,
            endOTP: data.endOTP || null,
            status: 'pending',
            isManualBooking: data.isManualBooking || data.bookingSource === 'manual' || false,
            bookingSource: data.bookingSource || 'online',
            expiresAt: data.expiresAt || null  // For manual booking countdown timer
          };
          
          console.log('[ModernDriverDashboard] Created ride object with OTPs:', {
            id: newRide._id,
            startOTP: newRide.startOTP,
            endOTP: newRide.endOTP,
            fare: newRide.fare,
            hasOTPs: {
              start: !!newRide.startOTP,
              end: !!newRide.endOTP
            }
          });
          
          setAssignedRides(prev => [newRide, ...prev]);
          
          // Show notification
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('🚕 New Ride Request!', {
              body: `${data.userName || 'Customer'} - ₹${data.driverFare || getDriverEarnings(data)}`,
              icon: '/favicon.ico'
            });
          }
        },
        onRideAssigned: (data) => {
          console.log('[ModernDriverDashboard] Ride assigned by admin:', data);
          
          const assignedRide = {
            _id: data.rideId,
            rideId: data.bookingId || data.rideId,
            bookingId: data.bookingId,
            userName: data.user?.name || data.userName,
            userPhone: data.user?.phone || data.userPhone,
            pickupLocation: {
              boothName: data.pickupLocation,
              latitude: 0,
              longitude: 0
            },
            dropLocation: {
              address: data.dropLocation,
              latitude: 0,
              longitude: 0
            },
            vehicleType: data.vehicleType,
            fare: getDriverEarnings(data),  // Use driver fare if available
            estimatedFare: getDriverEarnings(data),  // Use driver fare if available
            startOTP: data.startOTP,
            endOTP: data.endOTP,
            status: 'assigned',
            autoAssigned: true
          };
          
          setAssignedRides(prev => [assignedRide, ...prev]);
        },
        // Manual ride assignment handler removed - manual bookings now use newRideRequest
        // onManualRideAssigned handler was here but removed for unified flow
        onRideAcceptConfirmed: (data) => {
          console.log('[ModernDriverDashboard] Ride accept confirmed:', data);
          console.log('[ModernDriverDashboard] Full acceptance data:', JSON.stringify(data, null, 2));
          console.log('[ModernDriverDashboard] Ride OTPs received:', { 
            startOTP: data.startOTP, 
            endOTP: data.endOTP,
            hasStartOTP: !!data.startOTP,
            hasEndOTP: !!data.endOTP
          });
          
          // Production debugging - log all fields
          if (window.location.hostname !== 'localhost') {
            console.log('[PRODUCTION] Ride acceptance data fields:', {
              rideId: data.rideId,
              uniqueRideId: data.uniqueRideId,
              startOTP: data.startOTP,
              endOTP: data.endOTP,
              driverFare: data.driverFare, // Driver's base earnings only
              queueNumber: data.queueNumber,
              queuePosition: data.queuePosition,
              boothRideNumber: data.boothRideNumber
            });
          }
          
          // Find the ride from current state or use data.ride
          setAssignedRides(prev => {
            const acceptedRide = prev.find(r => r._id === data.rideId) || data.ride;
            
            if (acceptedRide) {
              // Set as active ride with all OTP data - ensure all fields are preserved
              const activeRideData = {
                ...acceptedRide,
                _id: data.rideId || acceptedRide._id,
                rideId: data.uniqueRideId || data.rideId || acceptedRide.rideId,
                status: 'accepted',
                queueNumber: data.queueNumber,
                queuePosition: data.queuePosition,
                acceptedAt: data.acceptedAt,
                // CRITICAL: Ensure OTPs are properly set from the acceptance data
                startOTP: data.startOTP || acceptedRide.startOTP || null,
                endOTP: data.endOTP || acceptedRide.endOTP || null,
                // Ensure fare is preserved (driver sees only their earnings)
                driverFare: data.driverFare || acceptedRide.driverFare,
                estimatedFare: data.driverFare || acceptedRide.driverFare || getDriverEarnings(data) || getDriverEarnings(acceptedRide),
                fare: data.driverFare || acceptedRide.driverFare || getDriverEarnings(data) || getDriverEarnings(acceptedRide),
                // Other important fields
                boothRideNumber: data.boothRideNumber || acceptedRide.boothRideNumber,
                userName: acceptedRide.userName,
                userPhone: acceptedRide.userPhone,
                pickupLocation: acceptedRide.pickupLocation,
                dropLocation: acceptedRide.dropLocation,
                vehicleType: acceptedRide.vehicleType,
                distance: acceptedRide.distance
              };
              
              console.log('[ModernDriverDashboard] Setting active ride with complete data:', {
                id: activeRideData._id,
                startOTP: activeRideData.startOTP,
                endOTP: activeRideData.endOTP,
                fare: activeRideData.fare,
                estimatedFare: activeRideData.estimatedFare,
                hasOTPs: {
                  start: !!activeRideData.startOTP,
                  end: !!activeRideData.endOTP
                }
              });
              
              // Production alert for debugging
              if (window.location.hostname !== 'localhost' && (!activeRideData.startOTP || !activeRideData.endOTP)) {
                console.error('[PRODUCTION ERROR] Missing OTP data:', {
                  startOTP: activeRideData.startOTP,
                  endOTP: activeRideData.endOTP,
                  originalData: data
                });
              }
              
              // CRITICAL: Save active ride to localStorage immediately to prevent loss
              try {
                localStorage.setItem('driver_active_ride_backup', JSON.stringify(activeRideData));
                console.log('[ModernDriverDashboard] Active ride backed up to localStorage');
                
                // Production-specific: Also save to a secondary backup
                if (window.location.hostname !== 'localhost') {
                  localStorage.setItem('driver_active_ride_backup_v2', JSON.stringify({
                    ...activeRideData,
                    backupTime: new Date().toISOString(),
                    hasOTPs: !!(activeRideData.startOTP || activeRideData.endOTP)
                  }));
                  console.log('[PRODUCTION] Secondary backup created');
                }
              } catch (error) {
                console.error('[ModernDriverDashboard] Failed to backup active ride:', error);
              }
              
              // FIX 1: Defer state update to avoid render-time updates (fixes React warning)
              // This prevents "Cannot update a component while rendering" error
              setTimeout(() => {
                actions.setActiveRide(activeRideData);
              }, 0);
              
              setRideStage('assigned');
              
              // Remove from assigned rides list
              return prev.filter(r => r._id !== data.rideId);
            }
            
            return prev;
          });
        },
        onRideStarted: (data) => {
          console.log('[ModernDriverDashboard] Ride started:', data);
          console.log('[ModernDriverDashboard] End OTP received:', data.endOTP);
          setRideStage('started');
          
          // Update active ride with endOTP
          actions.setActiveRide(prev => {
            const updatedRide = {
              ...prev,
              status: 'ride_started',
              endOTP: data.endOTP || prev?.endOTP // Ensure endOTP is set when ride starts
            };
            console.log('[ModernDriverDashboard] Updated active ride with endOTP:', {
              id: updatedRide._id,
              endOTP: updatedRide.endOTP,
              hasEndOTP: !!updatedRide.endOTP
            });
            return updatedRide;
          });
        },
        onRideCompleted: (data) => {
          console.log('[ModernDriverDashboard] Ride completed:', data);

          // Store completed ride details for animation (driver sees only their earnings)
          const driverEarnings = data.driverFare || activeRide.driverFare || getDriverEarnings(data.driverFare ? data : activeRide);
          const completedRide = {
            ...activeRide,
            driverFare: driverEarnings,  // Store as driverFare
            fare: driverEarnings,
            completedAt: new Date(),
            status: 'completed'
          };
          setCompletedRideDetails(completedRide);

          // Show completion animation
          setShowCompletionAnimation(true);

          // Update stats with animation (driver earnings only)
          setTripsToday(prev => prev + 1);
          setEarnings(prev => prev + driverEarnings);
          
          // Fetch updated ride history
          fetchRideHistory();
          
          // Clear active ride and animation after delay
          setTimeout(() => {
            actions.setActiveRide(null);
            setRideStage('assigned');
            setShowCompletionAnimation(false);
            setCompletedRideDetails(null);
            
            // Clear the backup since ride is completed
            localStorage.removeItem('driver_active_ride_backup');
            console.log('[ModernDriverDashboard] Cleared active ride backup after completion');
          }, 4000);
        },
        onDriverOnlineConfirmed: (data) => {
          console.log('[ModernDriverDashboard] Driver online confirmed:', data);

          // Check if this is a pending approval response
          if (data.pendingApproval) {
            console.log('[ModernDriverDashboard] Online request pending approval:', data);
            setPendingApproval(true);
            setPendingRequestId(data.requestId);
            setPendingExpiresAt(data.expiresAt);
            // Don't set online yet - wait for approval
          } else if (data.success !== false) {
            // Direct online (for backwards compatibility or instant approval)
            actions.setOnlineStatus(true);
            actions.setQueuePosition(data.queuePosition);
            setPendingApproval(false);
            setPendingRequestId(null);
            setPendingExpiresAt(null);
          }
        },
        onDriverOfflineConfirmed: (data) => {
          console.log('[ModernDriverDashboard] Driver offline response:', data);

          // Check if this is a pending approval response
          if (data && data.pendingApproval) {
            console.log('[ModernDriverDashboard] Offline request pending approval:', data);
            setPendingOfflineApproval(true);
            setPendingOfflineRequestId(data.requestId);
            setPendingOfflineExpiresAt(data.expiresAt);
            // Don't set offline yet - wait for approval
          } else if (!data || data.success !== false) {
            // Direct offline (instant approval or no approval needed)
            actions.setOnlineStatus(false);
            actions.setQueuePosition(null);
            setAssignedRides([]);
            actions.setActiveRide(null);
            // Clear any pending offline state
            setPendingOfflineApproval(false);
            setPendingOfflineRequestId(null);
            setPendingOfflineExpiresAt(null);
            setPendingOfflineTimeRemaining(null);
            // Reset debounce ref
            isRequestingRef.current = false;
          }
        },
        onQueuePositionUpdated: (data) => {
          console.log('[ModernDriverDashboard] Queue position update received:', data);
          console.log('[ModernDriverDashboard] Current queue position:', queuePosition);
          console.log('[ModernDriverDashboard] New queue position:', data.queuePosition);

          // Add debug logging for production
          if (window.location.hostname !== 'localhost') {
            console.log('[PRODUCTION] Queue position change:', {
              from: queuePosition,
              to: data.queuePosition,
              action: data.action,
              timestamp: data.timestamp,
              totalOnline: data.totalOnline
            });
          }

          actions.setQueuePosition(data.queuePosition);
        },
        onRideAcceptError: (data) => {
          console.log('[ModernDriverDashboard] Ride accept error:', data);
          alert(data.message || 'Failed to accept ride');
        },
        onRideCancelled: (data) => {
          console.log('[ModernDriverDashboard] Ride cancelled:', data);
          actions.setActiveRide(null);
          setRideStage('assigned');
          setAssignedRides(prev => prev.filter(r => r._id !== data.rideId));
        },
        onOTPVerificationSuccess: (data) => {
          console.log('[ModernDriverDashboard] OTP verification success:', data);
          setShowOTPInput(false);
          setOtpInput('');
        },
        onOTPVerificationError: (data) => {
          console.log('[ModernDriverDashboard] OTP verification error:', data);
          alert(data.message || 'Invalid OTP');
        },
        // Online request approval handlers
        onOnlineRequestApproved: (data) => {
          console.log('[ModernDriverDashboard] Online request approved:', data);
          setPendingApproval(false);
          setPendingRequestId(null);
          setPendingExpiresAt(null);
          setPendingTimeRemaining(null);
          actions.setOnlineStatus(true);
          actions.setQueuePosition(data.queuePosition);

          // Reset the debounce ref now that request is complete
          isRequestingRef.current = false;

          // Show success notification
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('You are now Online!', {
              body: `Queue position: #${data.queuePosition}`,
              icon: '/favicon.ico'
            });
          }
        },
        onOnlineRequestRejected: (data) => {
          console.log('[ModernDriverDashboard] Online request rejected:', data);
          setPendingApproval(false);
          setPendingRequestId(null);
          setPendingExpiresAt(null);
          setPendingTimeRemaining(null);

          // CRITICAL: Ensure driver is marked as offline when rejected
          actions.setOnlineStatus(false);
          actions.setQueuePosition(null);

          // Show persistent rejection banner (not just alert)
          const message = data.message || 'Your online request was rejected by admin';
          setRejectionMessage(message);

          // Also reset the debounce ref so driver can try again
          isRequestingRef.current = false;

          // Auto-clear the rejection message after 10 seconds
          setTimeout(() => setRejectionMessage(null), 10000);
        },
        onRemovedFromQueue: (data) => {
          console.log('[ModernDriverDashboard] Removed from queue:', data);
          actions.setOnlineStatus(false);
          actions.setQueuePosition(null);
          alert(data.message || 'You have been removed from the queue');
        },
        // Offline request approval handlers
        onOfflineRequestApproved: (data) => {
          console.log('[ModernDriverDashboard] Offline request approved:', data);
          setPendingOfflineApproval(false);
          setPendingOfflineRequestId(null);
          setPendingOfflineExpiresAt(null);
          setPendingOfflineTimeRemaining(null);

          // NOW set offline since approved
          actions.setOnlineStatus(false);
          actions.setQueuePosition(null);
          setAssignedRides([]);
          actions.setActiveRide(null);

          // Reset the debounce ref
          isRequestingRef.current = false;

          // Show success notification
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('You are now Offline', {
              body: 'Your offline request was approved',
              icon: '/favicon.ico'
            });
          }
        },
        onOfflineRequestRejected: (data) => {
          console.log('[ModernDriverDashboard] Offline request rejected:', data);
          setPendingOfflineApproval(false);
          setPendingOfflineRequestId(null);
          setPendingOfflineExpiresAt(null);
          setPendingOfflineTimeRemaining(null);

          // Driver STAYS ONLINE since request was rejected
          // Don't change isOnline status

          const message = data.message || 'Your offline request was rejected by admin';
          setRejectionMessage(message);
          isRequestingRef.current = false;

          // Auto-clear the rejection message after 10 seconds
          setTimeout(() => setRejectionMessage(null), 10000);
        },
        // Handle manual booking request expiry from server
        onRideRequestExpired: (data) => {
          console.log('[ModernDriverDashboard] Ride request expired:', data);
          // Remove the expired ride from the assigned rides list
          setAssignedRides(prev => prev.filter(r =>
            r._id !== data.rideId && r.bookingId !== data.bookingId
          ));
        },
        // Handle socket reconnection - sync React state when socket reconnects
        onSocketReconnected: () => {
          console.log('[ModernDriverDashboard] 📱 Socket reconnected event received');
          actions.setSocketConnected(true);
        }
      };

      subscribeToDriverUpdates(callbacks);

      return () => {
        unsubscribeFromDriverUpdates();
      };
    }
  }, [socket, socketConnected]);

  // Polling for approval status when socket is disconnected
  useEffect(() => {
    if (pendingApproval && !socketConnected) {
      console.log('[ModernDriverDashboard] Socket disconnected, starting approval polling');

      const pollInterval = setInterval(async () => {
        try {
          const response = await drivers.checkOnlineRequestStatus();
          console.log('[ModernDriverDashboard] Approval poll response:', response);

          if (response.success && response.data) {
            const status = response.data.status;

            if (status === 'approved') {
              setPendingApproval(false);
              setPendingRequestId(null);
              setPendingExpiresAt(null);
              setPendingTimeRemaining(null);
              actions.setOnlineStatus(true);
              actions.setQueuePosition(response.data.queuePosition);

              if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('You are now Online!', {
                  body: `Queue position: #${response.data.queuePosition}`,
                  icon: '/favicon.ico'
                });
              }
            } else if (status === 'rejected' || status === 'expired') {
              setPendingApproval(false);
              setPendingRequestId(null);
              setPendingExpiresAt(null);
              setPendingTimeRemaining(null);
              alert(response.data.message || `Your online request was ${status}`);
            }
          }
        } catch (error) {
          console.error('[ModernDriverDashboard] Error polling approval status:', error);
        }
      }, 5000); // Poll every 5 seconds for approval status

      return () => {
        console.log('[ModernDriverDashboard] Stopping approval polling');
        clearInterval(pollInterval);
      };
    }
  }, [pendingApproval, socketConnected]);

  // Polling for rides when socket is disconnected (only when online)
  useEffect(() => {
    if (isOnline && !socketConnected && !activeRide) {
      console.log('[ModernDriverDashboard] Socket disconnected, starting ride polling');

      const pollInterval = setInterval(async () => {
        try {
          const response = await drivers.checkPendingRides();
          console.log('[ModernDriverDashboard] Ride poll response:', response);

          if (response.success && response.data && response.data.pendingRide) {
            const newRide = response.data.pendingRide;

            setAssignedRides(prev => {
              const exists = prev.some(r => r._id === newRide._id);
              if (!exists) {
                console.log('[ModernDriverDashboard] New ride from polling:', newRide);

                if ('Notification' in window && Notification.permission === 'granted') {
                  new Notification('New Ride Request!', {
                    body: `${newRide.userName || 'Customer'} - ₹${newRide.driverFare || getDriverEarnings(newRide)}`,
                    icon: '/favicon.ico'
                  });
                }

                return [{
                  _id: newRide._id,
                  rideId: newRide.rideId || newRide.bookingId,
                  bookingId: newRide.bookingId,
                  userName: newRide.userName,
                  userPhone: newRide.userPhone,
                  pickupLocation: newRide.pickupLocation,
                  dropLocation: newRide.dropLocation,
                  vehicleType: newRide.vehicleType,
                  distance: newRide.distance,
                  driverFare: newRide.driverFare,
                  fare: newRide.driverFare || getDriverEarnings(newRide),
                  estimatedFare: newRide.driverFare || getDriverEarnings(newRide),
                  startOTP: newRide.startOTP,
                  endOTP: newRide.endOTP,
                  status: 'pending'
                }, ...prev];
              }
              return prev;
            });
          }
        } catch (error) {
          console.error('[ModernDriverDashboard] Error polling rides:', error);
        }
      }, 30000); // Poll every 30 seconds for rides

      return () => {
        console.log('[ModernDriverDashboard] Stopping ride polling');
        clearInterval(pollInterval);
      };
    }
  }, [isOnline, socketConnected, activeRide]);

  // Toggle online status
  const toggleOnlineStatus = async () => {
    if (!socketConnected) return;

    // DEBOUNCE: Prevent rapid multiple requests using sync ref check
    // This blocks immediately (sync), unlike state which is async
    if (isRequestingRef.current) {
      console.log('[ModernDriverDashboard] Request already in progress, ignoring rapid click');
      return;
    }

    // Block further requests immediately (sync)
    isRequestingRef.current = true;

    // Clear any previous rejection message when user tries again
    setRejectionMessage(null);

    setIsLoading(true);
    try {
      if (!isOnline && !pendingApproval) {
        // Going online - SET PENDING STATE IMMEDIATELY (don't wait for socket response)
        // This prevents DriverStateContext from racing with state sync
        const tempExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        setPendingApproval(true);
        setPendingExpiresAt(tempExpiresAt);

        console.log('[ModernDriverDashboard] Requesting to go online (pending set immediately)...');
        driverGoOnline({
          vehicleType: driver?.vehicleType || 'auto',
          metroBooth: driver?.assignedBooth || 'Default Booth',
          location: { lat: 28.6139, lng: 77.2090 } // Default Delhi location
        });
        // Socket response will update requestId and exact expiresAt
        // Keep isRequestingRef.current = true until approval/rejection/expiry
      } else if (pendingApproval) {
        // Cancel pending online request
        console.log('[ModernDriverDashboard] Cancelling pending online request...');
        await cancelOnlineRequest();
        // Reset ref after cancel
        isRequestingRef.current = false;
      } else if (pendingOfflineApproval) {
        // Cancel pending offline request
        console.log('[ModernDriverDashboard] Cancelling pending offline request...');
        await cancelOfflineRequest();
        // Reset ref after cancel
        isRequestingRef.current = false;
      } else {
        // Going offline - DON'T set offline immediately, wait for server response
        console.log('[ModernDriverDashboard] Requesting to go offline...');

        // Set pending state immediately (optimistic) - will be updated by socket response
        const tempExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
        setPendingOfflineApproval(true);
        setPendingOfflineExpiresAt(tempExpiresAt);

        driverGoOffline();
        // Socket response will update actual pending state or confirm offline
        // Keep isRequestingRef.current = true until approval/rejection/expiry
      }
    } catch (error) {
      console.error('Error toggling status:', error);
      // Reset pending state on error
      setPendingApproval(false);
      setPendingExpiresAt(null);
      setPendingOfflineApproval(false);
      setPendingOfflineExpiresAt(null);
      // Reset ref on error so driver can retry
      isRequestingRef.current = false;
    } finally {
      setIsLoading(false);
    }
  };

  // Cancel pending online request
  const cancelOnlineRequest = async () => {
    try {
      const response = await drivers.cancelOnlineRequest();
      if (response.success) {
        setPendingApproval(false);
        setPendingRequestId(null);
        setPendingExpiresAt(null);
        setPendingTimeRemaining(null);
        console.log('[ModernDriverDashboard] Online request cancelled');
      }
    } catch (error) {
      console.error('[ModernDriverDashboard] Error cancelling online request:', error);
    }
  };

  // Cancel pending offline request
  const cancelOfflineRequest = async () => {
    try {
      const response = await drivers.cancelOfflineRequest();
      if (response.success) {
        setPendingOfflineApproval(false);
        setPendingOfflineRequestId(null);
        setPendingOfflineExpiresAt(null);
        setPendingOfflineTimeRemaining(null);
        console.log('[ModernDriverDashboard] Offline request cancelled');
      }
    } catch (error) {
      console.error('[ModernDriverDashboard] Error cancelling offline request:', error);
    }
  };

  // Accept ride
  const acceptRide = async (ride) => {
    if (!socketConnected || !driver) {
      alert('Connection required to accept ride');
      return;
    }

    try {
      const acceptData = {
        rideId: ride._id,
        driverId: driver._id || driver.id,
        driverName: driver.fullName || driver.name,
        driverPhone: driver.phone || driver.mobileNo,
        vehicleDetails: {
          type: driver?.vehicleType || 'auto',
          number: driver.vehicleNumber || driver.vehicleNo
        },
        currentLocation: { lat: 28.6139, lng: 77.2090 }
      };
      
      console.log('[ModernDriverDashboard] Accepting ride:', acceptData);
      
      // Call with callback to handle response
      driverAcceptRide(acceptData, (response) => {
        console.log('[ModernDriverDashboard] Accept response:', response);
        if (response && response.success) {
          // Don't remove here, wait for onRideAcceptConfirmed event
          console.log('[ModernDriverDashboard] Ride accepted successfully');
        } else {
          alert(response?.message || 'Failed to accept ride');
        }
      });
      
      setSelectedRide(null);
      setShowBottomSheet(false);
    } catch (error) {
      console.error('Error accepting ride:', error);
      alert('Error accepting ride. Please try again.');
    }
  };

  // Reject ride
  const rejectRide = async (ride) => {
    if (!socketConnected || !driver) return;

    try {
      if (socket) {
        const rejectData = {
          rideId: ride._id,
          driverId: driver._id || driver.id,
          reason: 'Driver not available'
        };
        
        socket.emit('driverRejectRide', rejectData, (response) => {
          console.log('[ModernDriverDashboard] Reject response:', response);
          if (response && response.success) {
            actions.removeRideRequest(ride._id || ride.id);
            setAssignedRides(prev => prev.filter(r => r._id !== ride._id));
          }
        });
      }
      
      setSelectedRide(null);
      setShowBottomSheet(false);
    } catch (error) {
      console.error('Error rejecting ride:', error);
    }
  };

  // Cancel active ride
  const handleCancelRide = async () => {
    if (!activeRide || !socketConnected || !driver) {
      console.log('[ModernDriverDashboard] Cannot cancel ride - missing requirements');
      return;
    }

    // Show confirmation dialog
    const confirmCancel = window.confirm(
      `Are you sure you want to cancel this ride?

` +
      `Customer: ${activeRide.userName || 'Customer'}
` +
      `Fare: ₹${activeRide.driverFare || getDriverEarnings(activeRide)}

` +
      `Note: Cancelling rides may affect your rating.`
    );

    if (!confirmCancel) {
      console.log('[ModernDriverDashboard] Ride cancellation aborted by user');
      return;
    }

    try {
      const cancelData = {
        rideId: activeRide._id || activeRide.rideId,
        driverId: driver._id || driver.id,
        reason: rideStage === 'started' 
          ? 'Driver cancelled active ride' 
          : 'Driver cancelled before starting',
        cancellationStage: rideStage,
        timestamp: new Date().toISOString()
      };

      console.log('[ModernDriverDashboard] Cancelling ride:', cancelData);

      cancelRide(cancelData, (response) => {
        console.log('[ModernDriverDashboard] Cancel response:', response);
        
        if (response && response.success) {
          // Clear active ride and reset UI
          actions.setActiveRide(null);
          setRideStage('assigned');
          setShowOTPInput(false);
          setOtpInput('');
          
          // Clear the backup since ride is cancelled
          localStorage.removeItem('driver_active_ride_backup');
          console.log('[ModernDriverDashboard] Cleared active ride backup after cancellation');
          
          // Show success notification
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Ride Cancelled', {
              body: 'The ride has been cancelled successfully.',
              icon: '/favicon.ico'
            });
          }
          
          alert('Ride cancelled successfully');
        } else {
          alert(response?.message || 'Failed to cancel ride. Please try again.');
        }
      });
    } catch (error) {
      console.error('[ModernDriverDashboard] Error cancelling ride:', error);
      alert('Error cancelling ride. Please try again.');
    }
  };

  // Verify OTP
  const handleOTPVerification = async () => {
    if (otpInput.length < 4 || !activeRide) return;

    console.log('[ModernDriverDashboard] OTP Verification attempt:', {
      rideStage,
      otpInput,
      activeRideId: activeRide._id,
      activeRideEndOTP: activeRide.endOTP,
      verifyingType: rideStage === 'assigned' ? 'START' : 'END'
    });

    try {
      const otpData = {
        rideId: activeRide._id || activeRide.rideId,
        otp: otpInput.trim()
      };

      const handleResponse = (response) => {
        console.log('[ModernDriverDashboard] OTP verification response:', response);
        
        if (response && response.success) {
          console.log('[ModernDriverDashboard] OTP verified successfully');
          setOtpInput('');
          setShowOTPInput(false);
          
          if (rideStage === 'assigned') {
            console.log('[ModernDriverDashboard] Starting ride after OTP verification');
            setRideStage('started');
            actions.setActiveRide({ ...activeRide, status: 'ride_started' });
          } else {
            console.log('[ModernDriverDashboard] Completing ride after OTP verification');
            actions.setActiveRide(null);
            setRideStage('assigned');
          }
        } else {
          console.error('[ModernDriverDashboard] OTP verification failed:', response);
          alert(response?.message || 'Invalid OTP. Please try again.');
        }
      };

      if (rideStage === 'assigned') {
        console.log('[ModernDriverDashboard] Calling verifyStartOTP');
        verifyStartOTP(otpData, handleResponse);
      } else {
        console.log('[ModernDriverDashboard] Calling verifyEndOTP with:', otpData);
        verifyEndOTP(otpData, handleResponse);
      }
    } catch (error) {
      console.error('OTP verification error:', error);
    }
  };

  // Get all rides
  const getAllRides = () => {
    const allRides = [...rideRequests, ...assignedRides];
    return allRides.filter((ride, index, self) =>
      index === self.findIndex((r) => r._id === ride._id)
    );
  };

  // Logout - Admin-Only Queue Management System
  // Driver stays in queue as "Not Reachable" - admin must remove them
  const handleLogout = () => {
    console.log('[ModernDriverDashboard] Logout initiated');

    // NOTE: Do NOT emit driverGoOffline on logout
    // With Admin-Only Queue Management, driver stays in queue as "Not Reachable"
    // Server will mark them as 'disconnected' when socket closes
    // Admin can manually remove them using "Remove from Queue" button

    // Clear ALL driver state from localStorage (via DriverStateContext)
    // This clears: driverStatus, driverQueuePosition, driverActiveRide, driverLastKnownState
    if (actions && actions.clearState) {
      console.log('[ModernDriverDashboard] Clearing driver state from context');
      actions.clearState();
    }

    // Clear auth tokens
    localStorage.removeItem('driverToken');
    localStorage.removeItem('driverInfo');
    localStorage.removeItem('driver');

    console.log('[ModernDriverDashboard] Logout complete - driver stays in queue as disconnected');
    navigate('/driver/login');
  };

  // Fetch ride history - Show ONLY driver earnings, never customer fares
  const fetchRideHistory = async () => {
    try {
      setHistoryLoading(true);
      const response = await drivers.getRideHistory(1, 30, 'completed'); // Get more rides to filter

      if (response.success && response.data && response.data.rideHistory) {
        console.log(`[ModernDriverDashboard] Fetched ${response.data.rideHistory.length} total completed rides`);

        // Primary filter: ONLY rides that have driverFare field (confirmed driver earnings)
        const ridesWithDriverFare = response.data.rideHistory.filter(ride =>
          ride.driverFare && ride.driverFare > 0
        );

        // Secondary: older rides without driverFare — use stored fare field as-is
        const legacyRides = response.data.rideHistory.filter(ride =>
          (!ride.driverFare || ride.driverFare === 0) && ride.fare && ride.fare > 0
        );

        const allDriverEarningsRides = [
          ...ridesWithDriverFare,
          ...legacyRides.slice(0, 5)
        ];

        console.log(`[ModernDriverDashboard] Driver earnings rides breakdown:`);
        console.log(`  - With driverFare: ${ridesWithDriverFare.length}`);
        console.log(`  - Legacy rides: ${legacyRides.length}`);
        console.log(`  - Total showing: ${allDriverEarningsRides.length}`);

        // Take only the first 10 rides total
        setRideHistory(allDriverEarningsRides.slice(0, 10));
      }
    } catch (error) {
      console.error('Error fetching ride history:', error);
      setRideHistory([]); // Clear history on error
    } finally {
      setHistoryLoading(false);
    }
  };

  // Load ride history on mount
  useEffect(() => {
    if (driver && socketConnected) {
      fetchRideHistory();
    }
  }, [driver, socketConnected]);

  // Debug: Track queue position changes
  useEffect(() => {
    if (queuePosition !== undefined) {
      const timestamp = new Date().toISOString();
      console.log(`[ModernDriverDashboard] Queue Position Change Detected:`, {
        newPosition: queuePosition,
        timestamp,
        isOnline,
        socketConnected,
        driverId: driver?._id
      });

      // Production debug logging
      if (window.location.hostname !== 'localhost') {
        console.log(`[PRODUCTION] Queue position changed to: ${queuePosition} at ${timestamp}`);
      }
    }
  }, [queuePosition]);

  return (
    <div className="h-screen w-full flex flex-col bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200 px-4 py-3 flex items-center justify-between z-10">
        <div className="flex items-center space-x-3">
          <h1 className="text-xl font-bold text-gray-900">Driver</h1>
          {socketConnected ? (
            <div className="flex items-center text-green-600 text-sm">
              <FaWifi className="mr-1" />
              <span>Connected</span>
            </div>
          ) : (
            <div className="flex items-center text-red-600 text-sm">
              <FaExclamationTriangle className="mr-1" />
              <span>Disconnected</span>
            </div>
          )}
        </div>
        <button
          onClick={handleLogout}
          className="p-2 rounded-lg bg-gray-100 hover:bg-gray-200 transition-colors"
        >
          <FaSignOutAlt className="text-gray-600" />
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Pending Approval Banner */}
        {pendingApproval && (
          <div className="bg-yellow-50 border-l-4 border-yellow-400 m-4 p-4 rounded-lg shadow-sm">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <FaClock className="h-5 w-5 text-yellow-400" />
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-yellow-800">
                  Waiting for Approval
                </h3>
                <p className="mt-1 text-sm text-yellow-700">
                  Your online request is pending admin approval.
                </p>
                {pendingTimeRemaining && (
                  <p className="mt-1 text-sm font-semibold text-yellow-800">
                    Expires in: {pendingTimeRemaining}
                  </p>
                )}
              </div>
              <button
                onClick={cancelOnlineRequest}
                className="ml-auto px-3 py-1 bg-yellow-200 text-yellow-800 rounded-lg text-sm font-medium hover:bg-yellow-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Pending Offline Approval Banner */}
        {pendingOfflineApproval && (
          <div className="bg-orange-50 border-l-4 border-orange-400 m-4 p-4 rounded-lg shadow-sm">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <FaClock className="h-5 w-5 text-orange-400" />
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-orange-800">
                  Requesting to Go Offline
                </h3>
                <p className="mt-1 text-sm text-orange-700">
                  Your offline request is pending admin approval.
                </p>
                {pendingOfflineTimeRemaining && (
                  <p className="mt-1 text-sm font-semibold text-orange-800">
                    Expires in: {pendingOfflineTimeRemaining}
                  </p>
                )}
              </div>
              <button
                onClick={cancelOfflineRequest}
                className="ml-auto px-3 py-1 bg-orange-200 text-orange-800 rounded-lg text-sm font-medium hover:bg-orange-300 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Rejection Message Banner */}
        {rejectionMessage && (
          <div className="bg-red-50 border-l-4 border-red-400 m-4 p-4 rounded-lg shadow-sm">
            <div className="flex items-start">
              <div className="flex-shrink-0">
                <FaExclamationTriangle className="h-5 w-5 text-red-400" />
              </div>
              <div className="ml-3 flex-1">
                <h3 className="text-sm font-medium text-red-800">
                  Request Rejected
                </h3>
                <p className="mt-1 text-sm text-red-700">
                  {rejectionMessage}
                </p>
                <p className="mt-1 text-xs text-red-600">
                  You can submit a new request to go online.
                </p>
              </div>
              <button
                onClick={() => setRejectionMessage(null)}
                className="ml-auto p-1 text-red-400 hover:text-red-600 transition-colors"
                title="Dismiss"
              >
                <FaTimes className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Personal Info Card - Collapsible */}
        {driver && (
          <div className="m-4">
            <div
              onClick={() => setShowProfile(!showProfile)}
              className="flex items-center justify-between bg-white rounded-xl shadow-sm p-4 cursor-pointer hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-center">
                <FaUser className="text-blue-600 mr-3" />
                <h3 className="text-lg font-semibold text-gray-800">My Profile</h3>
              </div>
              {showProfile ? <FaChevronUp className="text-gray-500" /> : <FaChevronDown className="text-gray-500" />}
            </div>

            {showProfile && (
              <div className="bg-white rounded-xl shadow-sm p-4 mt-2">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between items-center py-2 border-b border-gray-100">
                    <span className="text-gray-600">Name:</span>
                    <span className="font-medium text-gray-800">{driver.fullName || driver.name || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-gray-100">
                    <span className="text-gray-600">Phone:</span>
                    <span className="font-medium text-gray-800">{driver.mobileNo || driver.phone || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-gray-100">
                    <span className="text-gray-600">Vehicle No:</span>
                    <span className="font-medium text-gray-800">{driver.vehicleNo || driver.vehicleNumber || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between items-center py-2">
                    <span className="text-gray-600">Vehicle Type:</span>
                    <span className="font-medium text-gray-800 capitalize">{driver.vehicleType || 'N/A'}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Status Card */}
        <div className="bg-white m-4 rounded-xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-800">Driver Status</h2>
              {isOnline && queuePosition && (
                <p className="text-sm text-gray-600 mt-1">
                  Queue Position: <span className="font-bold text-blue-600">#{queuePosition}</span>
                  {queuePosition === 1 && <span className="ml-2">🚀 You're next!</span>}
                </p>
              )}
            </div>
            <button
              onClick={toggleOnlineStatus}
              disabled={isLoading || !socketConnected}
              className={`px-6 py-3 rounded-full font-semibold transition-all ${
                pendingOfflineApproval
                  ? 'bg-orange-500 text-white hover:bg-orange-600'
                  : isOnline
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : pendingApproval
                      ? 'bg-yellow-500 text-white hover:bg-yellow-600'
                      : 'bg-gray-800 text-white hover:bg-gray-900'
              } ${(!socketConnected || isLoading) && 'opacity-50 cursor-not-allowed'}`}
            >
              {isLoading ? (
                <span className="flex items-center">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  Loading...
                </span>
              ) : pendingOfflineApproval ? (
                <span className="flex items-center">
                  <FaClock className="inline mr-2" />
                  GOING OFFLINE...
                </span>
              ) : pendingApproval ? (
                <span className="flex items-center">
                  <FaClock className="inline mr-2" />
                  PENDING...
                </span>
              ) : (
                <>
                  <FaPowerOff className="inline mr-2" />
                  {isOnline ? 'ONLINE' : 'GO ONLINE'}
                </>
              )}
            </button>
          </div>

          {/* Quick Stats */}
          <div className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-gray-100">
            <div className="text-center">
              <FaWallet className="text-2xl text-green-500 mx-auto mb-1" />
              <p className={`text-2xl font-bold text-gray-800 transition-all duration-500 ${
                showCompletionAnimation ? 'scale-110 text-green-600' : ''
              }`}>
                ₹{earnings}
              </p>
              <p className="text-xs text-gray-500">Today's Earnings</p>
            </div>
            <div className="text-center">
              <FaCar className="text-2xl text-blue-500 mx-auto mb-1" />
              <p className={`text-2xl font-bold text-gray-800 transition-all duration-500 ${
                showCompletionAnimation ? 'scale-110 text-blue-600' : ''
              }`}>
                {tripsToday}
              </p>
              <p className="text-xs text-gray-500">Trips Completed</p>
            </div>
          </div>
        </div>

        {/* Active Ride Card */}
        {activeRide && (
          <div className="bg-gradient-to-br from-blue-500 to-blue-600 m-4 rounded-xl shadow-lg p-4 text-white">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Active Ride</h3>
              <span className="px-3 py-1 bg-white/20 rounded-full text-sm">
                {rideStage === 'started' ? 'In Progress' : 'Ready to Start'}
              </span>
            </div>

            {/* Customer Info */}
            <div className="bg-white/10 rounded-lg p-3 mb-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center">
                  <FaUser className="mr-2" />
                  <span>{activeRide.userName || 'Customer'}</span>
                </div>
                {activeRide.userPhone && (
                  <a
                    href={`tel:${activeRide.userPhone}`}
                    className="px-3 py-1 bg-white/20 rounded-full text-sm hover:bg-white/30"
                  >
                    <FaPhone className="inline mr-1" />
                    Call
                  </a>
                )}
              </div>
              <div className="text-2xl font-bold">₹{activeRide.driverFare || getDriverEarnings(activeRide)}</div>
            </div>

            {/* Locations */}
            <div className="space-y-2 mb-4">
              <div className="flex items-start">
                <FaMapMarkerAlt className="text-green-300 mt-1 mr-2" />
                <div className="flex-1">
                  <p className="text-xs opacity-75">Pickup</p>
                  <p className="text-sm">{activeRide.pickupLocation?.boothName || 'Pickup location'}</p>
                </div>
              </div>
              <div className="flex items-start">
                <FaMapMarkerAlt className="text-red-300 mt-1 mr-2" />
                <div className="flex-1">
                  <p className="text-xs opacity-75">Drop</p>
                  <p className="text-sm">{activeRide.dropLocation?.address || 'Drop location'}</p>
                </div>
              </div>
            </div>

            {/* OTP Input */}
            {showOTPInput ? (
              <div className="space-y-3">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength="6"
                  value={otpInput}
                  onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, ''))}
                  placeholder="Enter OTP"
                  className="w-full px-4 py-3 bg-white text-gray-800 rounded-lg text-center text-lg font-bold"
                  autoFocus
                />
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={handleOTPVerification}
                    disabled={otpInput.length < 4}
                    className="px-4 py-2 bg-white text-blue-600 rounded-lg font-semibold disabled:opacity-50"
                  >
                    Verify
                  </button>
                  <button
                    onClick={() => {
                      setShowOTPInput(false);
                      setOtpInput('');
                    }}
                    className="px-4 py-2 bg-white/20 text-white rounded-lg font-semibold"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Main action button */}
                <button
                  onClick={() => {
                    console.log('[ModernDriverDashboard] Button clicked:', {
                      rideStage,
                      activeRideId: activeRide?._id,
                      hasStartOTP: !!activeRide?.startOTP,
                      hasEndOTP: !!activeRide?.endOTP,
                      startOTP: activeRide?.startOTP,
                      endOTP: activeRide?.endOTP,
                      fullActiveRide: activeRide
                    });
                    
                    // Production debugging
                    if (window.location.hostname !== 'localhost') {
                      console.log('[PRODUCTION] Button click - Active ride OTP status:', {
                        stage: rideStage,
                        startOTP: activeRide?.startOTP,
                        endOTP: activeRide?.endOTP,
                        hasStartOTP: !!activeRide?.startOTP,
                        hasEndOTP: !!activeRide?.endOTP,
                        isProduction: true
                      });
                    }
                    
                    if (rideStage === 'assigned') {
                      if (activeRide.startOTP) {
                        console.log('[ModernDriverDashboard] Showing START OTP input for OTP:', activeRide.startOTP);
                        setShowOTPInput(true);
                      } else {
                        console.log('[ModernDriverDashboard] No START OTP required, starting ride directly');
                        setRideStage('started');
                      }
                    } else {
                      if (activeRide.endOTP) {
                        console.log('[ModernDriverDashboard] Showing END OTP input for OTP:', activeRide.endOTP);
                        setShowOTPInput(true);
                      } else {
                        console.log('[ModernDriverDashboard] No END OTP required, completing ride directly');
                        actions.setActiveRide(null);
                        setRideStage('assigned');
                      }
                    }
                  }}
                  className="w-full px-4 py-3 bg-white text-blue-600 rounded-lg font-semibold hover:bg-gray-50 transition-colors"
                >
                  {rideStage === 'assigned' ? 'Start Ride' : 'Complete Ride'}
                </button>

                {/* Open in Google Maps - Direct Launch */}
                <button
                  onClick={() => {
                    openGoogleMapsNavigation(
                      activeRide.pickupLocation,
                      activeRide.dropLocation
                    );
                  }}
                  className="w-full px-4 py-3 bg-slate-600 text-white rounded-lg font-bold hover:bg-slate-700 transition-colors flex items-center justify-center gap-2 shadow-lg"
                >
                  <FaRoute className="text-lg" />
                  <span>Open in Google Maps</span>
                </button>

                {/* Cancel button */}
                <button
                  onClick={handleCancelRide}
                  className="w-full px-4 py-3 bg-red-500/20 text-white rounded-lg font-semibold hover:bg-red-500/30 transition-colors flex items-center justify-center"
                >
                  <FaTimes className="mr-2" />
                  {rideStage === 'started' ? 'Cancel Active Ride' : 'Cancel Ride'}
                </button>
              </div>
            )}

            {/* Map Navigation Panel */}
            <MapNavigationPanel
              isOpen={showMapPanel}
              onClose={() => setShowMapPanel(false)}
              pickupLocation={activeRide.pickupLocation}
              dropLocation={activeRide.dropLocation}
              driverLocation={null}
              rideDetails={{
                fare: activeRide.driverFare || getDriverEarnings(activeRide),
                distance: activeRide.distance,
                vehicleType: activeRide.vehicleType,
              }}
            />
          </div>
        )}

        {/* Ride Requests */}
        {!activeRide && (
          <div className="m-4">
            <h3 className="text-lg font-semibold text-gray-800 mb-3">
              {getAllRides().length > 0 ? 'Available Rides' : 'No Rides Available'}
            </h3>
            
            {getAllRides().length > 0 ? (
              <div className="space-y-3">
                {getAllRides().map((ride) => (
                  <div
                    key={ride._id || ride.id}
                    className={`bg-white rounded-xl shadow-sm p-4 border ${
                      ride.isManualBooking ? 'border-orange-300 ring-2 ring-orange-200' : 'border-gray-100'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="text-2xl font-bold text-gray-800">₹{ride.driverFare || getDriverEarnings(ride)}</p>
                        <p className="text-sm text-gray-500">{ride.distance || 'N/A'} km</p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <span className="px-3 py-1 bg-blue-50 text-blue-600 text-xs font-semibold rounded-full">
                          {ride.vehicleType?.toUpperCase() || 'AUTO'}
                        </span>
                        {ride.isManualBooking && (
                          <span className="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs font-medium rounded-full">
                            Admin Booking
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Manual Booking Timer - Shows countdown for time-limited requests */}
                    {ride.isManualBooking && manualBookingTimers[ride._id] !== undefined && (
                      <div className={`flex items-center justify-center p-2 mb-3 rounded-lg ${
                        manualBookingTimers[ride._id] <= 5
                          ? 'bg-red-100 text-red-700 animate-pulse'
                          : 'bg-orange-100 text-orange-700'
                      }`}>
                        <FaClock className="mr-2" />
                        <span className="font-bold text-lg">
                          {manualBookingTimers[ride._id]}s
                        </span>
                        <span className="ml-2 text-sm">remaining to accept</span>
                      </div>
                    )}

                    <div className="space-y-2 mb-3">
                      <div className="flex items-center text-sm text-gray-600">
                        <FaMapMarkerAlt className="text-green-500 mr-2" />
                        <span className="truncate">{ride.pickupLocation?.boothName || 'Pickup'}</span>
                      </div>
                      <div className="flex items-center text-sm text-gray-600">
                        <FaMapMarkerAlt className="text-red-500 mr-2" />
                        <span className="truncate">{ride.dropLocation?.address || 'Drop'}</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => acceptRide(ride)}
                        className={`px-4 py-2 text-white rounded-lg font-semibold ${
                          ride.isManualBooking && manualBookingTimers[ride._id] <= 5
                            ? 'bg-orange-500 hover:bg-orange-600 animate-pulse'
                            : 'bg-green-500 hover:bg-green-600'
                        }`}
                      >
                        {ride.isManualBooking ? 'Accept Now' : 'Accept'}
                      </button>
                      <button
                        onClick={() => rejectRide(ride)}
                        className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg font-semibold hover:bg-gray-300"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow-sm p-8 text-center">
                <FaCar className="text-4xl text-gray-300 mx-auto mb-3" />
                <p className="text-gray-500">
                  {isOnline ? 'Waiting for ride requests...' : 'Go online to receive rides'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recent Rides Section - ONLY rides with driver fare */}
      {!activeRide && (
        <div className="m-4">
          <div
            onClick={() => setShowHistory(!showHistory)}
            className="flex items-center justify-between bg-white rounded-xl shadow-sm p-4 cursor-pointer hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center">
              <FaHistory className="text-gray-600 mr-3" />
              <h3 className="text-lg font-semibold text-gray-800">Your Earnings History</h3>
              {rideHistory.length > 0 && (
                <span className="ml-2 px-2 py-1 bg-green-100 text-green-600 text-xs rounded-full">
                  {rideHistory.length} rides • driver earnings only
                </span>
              )}
            </div>
            {showHistory ? <FaChevronUp className="text-gray-500" /> : <FaChevronDown className="text-gray-500" />}
          </div>

          {/* Expandable History List - controlled by showHistory toggle */}
          {showHistory && (
            <>
              {historyLoading ? (
                <div className="bg-white rounded-xl shadow-sm p-6 mt-3">
                  <div className="text-center text-gray-500">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto mb-2"></div>
                    Loading recent rides...
                  </div>
                </div>
              ) : rideHistory.length === 0 ? (
                <div className="bg-white rounded-xl shadow-sm p-6 mt-3">
                  <div className="text-center text-gray-500">
                    <FaHistory className="text-4xl text-gray-300 mx-auto mb-3" />
                    <p className="font-medium">No Earnings History Available</p>
                    <p className="text-sm mt-1">Complete rides to see your driver earnings here</p>
                    <p className="text-xs mt-2 text-blue-600">Shows only your earnings, not customer fares</p>
                  </div>
                </div>
              ) : (
                <div className="mt-3">
                  <div className="space-y-2 max-h-80 overflow-y-auto">
                    {rideHistory.map((ride, index) => (
                      <div
                        key={ride._id}
                        className={`bg-white rounded-lg p-3 border border-gray-100 transform transition-all duration-500 ${
                          index === 0 && showCompletionAnimation ? 'animate-pulse bg-green-50' : ''
                        }`}
                        style={{
                          animation: index === 0 && showCompletionAnimation ? 'slideIn 0.5s ease-out' : 'none'
                        }}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center">
                            <FaCheckCircle className="text-green-500 mr-2" />
                            {/* Show ONLY driver earnings - never customer fares */}
                            {ride.driverFare && ride.driverFare > 0 ? (
                              <>
                                <span className="font-bold text-green-600 text-lg">₹{ride.driverFare}</span>
                                <span className="ml-1 text-xs text-green-500 font-medium">driver earnings</span>
                              </>
                            ) : ride.isCalculated ? (
                              <>
                                <span className="font-bold text-blue-600 text-lg">₹{ride.calculatedDriverEarnings}</span>
                                <span className="ml-1 text-xs text-blue-500 font-medium">calculated</span>
                              </>
                            ) : (
                              <>
                                <span className="font-bold text-green-600 text-lg">₹{ride.driverFare || getDriverEarnings(ride)}</span>
                                <span className="ml-1 text-xs text-gray-500 font-medium">estimated</span>
                              </>
                            )}
                          </div>
                          <span className="text-xs text-gray-500">
                            {new Date(ride.createdAt || ride.completedAt).toLocaleTimeString('en-US', {
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </span>
                        </div>
                        <div className="text-xs text-gray-600 space-y-1">
                          <div className="flex items-center">
                            <FaRoute className="mr-1" />
                            <span className="truncate">{ride.pickupLocation?.boothName || 'Pickup'} → {ride.dropLocation?.address || 'Drop'}</span>
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center">
                              <FaUser className="mr-1" />
                              <span>{ride.userName || ride.userId?.name || 'Customer'}</span>
                            </div>
                            {ride.distance && (
                              <span className="text-xs text-gray-500">{ride.distance}km</span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Clarification about driver earnings display */}
                  <div className="mt-3 p-2 bg-green-50 rounded-lg border border-green-200">
                    <p className="text-xs text-green-700 text-center">
                      <span className="font-medium">Your Earnings Only</span>
                      <br />Shows your base fare earnings, not customer total charges
                    </p>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Completion Animation Overlay */}
      {showCompletionAnimation && completedRideDetails && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 pointer-events-none">
          <div className="bg-white rounded-2xl p-8 transform scale-100 animate-bounce-in max-w-sm mx-4">
            <div className="text-center">
              {/* Success Icon with Animation */}
              <div className="relative inline-block">
                <div className="w-24 h-24 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4 animate-pulse">
                  <FaCheckCircle className="text-5xl text-green-500 animate-check-mark" />
                </div>
                {/* Confetti particles */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="confetti-particle bg-yellow-400"></div>
                  <div className="confetti-particle bg-blue-400" style={{animationDelay: '0.1s'}}></div>
                  <div className="confetti-particle bg-green-400" style={{animationDelay: '0.2s'}}></div>
                  <div className="confetti-particle bg-red-400" style={{animationDelay: '0.3s'}}></div>
                  <div className="confetti-particle bg-purple-400" style={{animationDelay: '0.4s'}}></div>
                </div>
              </div>
              
              <h2 className="text-2xl font-bold text-gray-800 mb-2">Ride Completed!</h2>
              <p className="text-gray-600 mb-4">Great job! You've earned</p>
              
              <div className="text-4xl font-bold text-green-600 mb-6 animate-pulse">
                ₹{completedRideDetails.driverFare || getDriverEarnings(completedRideDetails)}
              </div>
              
              <div className="space-y-2 text-sm text-gray-600">
                <div className="flex items-center justify-center">
                  <FaClock className="mr-2" />
                  <span>Completed at {new Date(completedRideDetails.completedAt).toLocaleTimeString()}</span>
                </div>
                <div className="flex items-center justify-center">
                  <FaUser className="mr-2" />
                  <span>{completedRideDetails.userName || 'Customer'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add custom animations to head */}
      <style>{`
        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        @keyframes bounce-in {
          0% {
            opacity: 0;
            transform: scale(0.3);
          }
          50% {
            opacity: 1;
            transform: scale(1.05);
          }
          70% {
            transform: scale(0.9);
          }
          100% {
            transform: scale(1);
          }
        }
        
        .animate-bounce-in {
          animation: bounce-in 0.6s ease-out;
        }
        
        @keyframes check-mark {
          0% {
            transform: scale(0) rotate(0deg);
          }
          50% {
            transform: scale(1.2) rotate(360deg);
          }
          100% {
            transform: scale(1) rotate(360deg);
          }
        }
        
        .animate-check-mark {
          animation: check-mark 0.6s ease-out;
        }
        
        .confetti-particle {
          position: absolute;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          animation: confetti-fall 1s ease-out forwards;
        }
        
        @keyframes confetti-fall {
          0% {
            transform: translateY(0) translateX(0) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(100px) translateX(var(--x-offset, 30px)) rotate(720deg);
            opacity: 0;
          }
        }
        
        .confetti-particle:nth-child(1) { --x-offset: -30px; top: 20px; left: 40px; }
        .confetti-particle:nth-child(2) { --x-offset: 30px; top: 10px; left: 50px; }
        .confetti-particle:nth-child(3) { --x-offset: -20px; top: 30px; left: 30px; }
        .confetti-particle:nth-child(4) { --x-offset: 40px; top: 15px; left: 60px; }
        .confetti-particle:nth-child(5) { --x-offset: -40px; top: 25px; left: 45px; }
      `}</style>

      {/* Mobile Bottom Sheet for Ride Details */}
      {isMobile && selectedRide && (
        <div className={`fixed inset-x-0 bottom-0 bg-white rounded-t-2xl shadow-2xl transform transition-transform duration-300 z-50 ${
          showBottomSheet ? 'translate-y-0' : 'translate-y-full'
        }`}>
          <div className="w-12 h-1 bg-gray-300 rounded-full mx-auto mt-3" />
          <div className="p-4">
            <h3 className="text-lg font-semibold mb-3">Ride Details</h3>
            {/* Ride details content */}
          </div>
        </div>
      )}
    </div>
  );
};

export default ModernDriverDashboard;