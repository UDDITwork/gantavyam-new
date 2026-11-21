import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { GoogleMap, Autocomplete, Marker, DirectionsRenderer } from '@react-google-maps/api';
import { FaMapMarkerAlt, FaCar, FaMotorcycle, FaTaxi, FaUser, FaRupeeSign, FaCheckCircle, FaSpinner, FaUserPlus, FaSearch, FaArrowLeft, FaArrowRight, FaUsers, FaClock, FaPhone, FaTimes, FaPaperPlane, FaExclamationTriangle, FaClipboardList } from 'react-icons/fa';
import { admin, users } from '../../services/api';
import { FIXED_PICKUP_LOCATION } from '../../config/fixedLocations';
import { initializeSocket, getSocket } from '../../services/socket';
import { getImageUrl } from '../../utils/imageUtils';
import toast, { Toaster } from 'react-hot-toast';

const STORAGE_KEY = 'manualBookingState';

const ManualBooking = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [dropLocation, setDropLocation] = useState('');
  const [dropCoordinates, setDropCoordinates] = useState(null);
  const [dropLocationConfirmed, setDropLocationConfirmed] = useState(false);
  const [fareEstimates, setFareEstimates] = useState(null);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [isCalculatingFare, setIsCalculatingFare] = useState(false);
  const [userPhone, setUserPhone] = useState('');
  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [existingUser, setExistingUser] = useState(null);
  const [showRegistrationForm, setShowRegistrationForm] = useState(false);
  const [isLookingUpCustomer, setIsLookingUpCustomer] = useState(false);
  const [isRegisteringCustomer, setIsRegisteringCustomer] = useState(false);
  const [bookingDetails, setBookingDetails] = useState(null);
  const [autocomplete, setAutocomplete] = useState(null);
  const [showRecoveryModal, setShowRecoveryModal] = useState(false);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [mapsError, setMapsError] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [mapInstance, setMapInstance] = useState(null);
  const [directions, setDirections] = useState(null);
  const [isCalculatingRoute, setIsCalculatingRoute] = useState(false);
  const [routeError, setRouteError] = useState(null);

  // Driver selection state
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [availableDrivers, setAvailableDrivers] = useState([]);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [driverError, setDriverError] = useState('');

  // Queue Management state (matching QueueManagement.js for full functionality)
  const [activeDriverTab, setActiveDriverTab] = useState('queue'); // 'queue' | 'requests'
  const [pendingRequests, setPendingRequests] = useState([]);
  const [pendingRequestsCount, setPendingRequestsCount] = useState(0);
  const [pendingOfflineRequests, setPendingOfflineRequests] = useState([]);
  const [pendingOfflineRequestsCount, setPendingOfflineRequestsCount] = useState(0);
  const [processingRequestId, setProcessingRequestId] = useState(null);
  const [queueSuccess, setQueueSuccess] = useState('');
  const [queueError, setQueueError] = useState('');

  // Disconnected driver warning modal state
  const [showDisconnectedWarning, setShowDisconnectedWarning] = useState(false);
  const [disconnectedDriverForWarning, setDisconnectedDriverForWarning] = useState(null);
  
  // Socket connection state
  const [socket, setSocket] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [waitingForDriverResponse, setWaitingForDriverResponse] = useState(false);

  // Resend OTP state
  const [isResendingOTP, setIsResendingOTP] = useState(false);

  // Payment state
  const [paymentMode, setPaymentMode] = useState('cash'); // 'cash' or 'online'

  // NEW: Fleet Manager workflow state
  const [pendingFmRequests, setPendingFmRequests] = useState([]); // All pending FM requests (sidebar)
  const [submittedToFm, setSubmittedToFm] = useState(false); // Shows pending status after submit
  const [currentFmBooking, setCurrentFmBooking] = useState(null); // Current booking submitted to FM
  const [fmStatus, setFmStatus] = useState('none'); // 'none' | 'submitting' | 'pending' | 'assigned' | 'cancelled'

  // NEW: Request tracking state for step 5 (driver selection with timer)
  const [requestStatus, setRequestStatus] = useState('none');
  // Values: 'none' | 'sending' | 'waiting' | 'accepted' | 'rejected' | 'expired' | 'failed'

  const [activeRequest, setActiveRequest] = useState(null);
  // { rideId, bookingId, driverId, driverName, sentAt, expiresAt, startOTP, endOTP, rejectionReason, errorMessage }

  const [requestTimer, setRequestTimer] = useState(15);
  const timerRef = useRef(null);

  // Fixed pickup location (same as online booking)
  const currentBooth = FIXED_PICKUP_LOCATION;

  // Helper function to get vehicle options with icons
  const getVehicleOptions = () => {
    return [
      { 
        type: 'bike', 
        label: 'Bike',
        icon: <FaMotorcycle />,
        available: true,
        eta: '2 mins away',
        price: fareEstimates?.estimates?.bike?.customerTotalFare || fareEstimates?.estimates?.bike?.totalFare || (fareEstimates ? 'Calculating...' : 25)
      },
      { 
        type: 'auto', 
        label: 'Auto',
        icon: <FaTaxi />,
        available: true,
        eta: '3 mins away',
        price: fareEstimates?.estimates?.auto?.customerTotalFare || fareEstimates?.estimates?.auto?.totalFare || (fareEstimates ? 'Calculating...' : 40)
      },
      { 
        type: 'car', 
        label: 'Car',
        icon: <FaCar />,
        available: true,
        eta: '5 mins away',
        price: fareEstimates?.estimates?.car?.customerTotalFare || fareEstimates?.estimates?.car?.totalFare || (fareEstimates ? 'Calculating...' : 80)
      }
    ];
  };

  // Helper function to find vehicle by type (for state restoration)
  const findVehicleByType = (vehicleType) => {
    const vehicleMap = {
      'bike': { type: 'bike', label: 'Bike', icon: <FaMotorcycle />, eta: '2 mins away' },
      'auto': { type: 'auto', label: 'Auto', icon: <FaTaxi />, eta: '3 mins away' },
      'car': { type: 'car', label: 'Car', icon: <FaCar />, eta: '5 mins away' }
    };
    
    const baseVehicle = vehicleMap[vehicleType];
    if (!baseVehicle) return null;
    
    return {
      ...baseVehicle,
      available: true,
      price: fareEstimates?.estimates?.[vehicleType]?.customerTotalFare || fareEstimates?.estimates?.[vehicleType]?.totalFare || (fareEstimates ? 'Calculating...' : (vehicleType === 'bike' ? 25 : vehicleType === 'auto' ? 40 : 80))
    };
  };

  // State persistence functions
  const saveBookingState = () => {
    // Don't save selectedVehicle with JSX icons - save only serializable data
    const serializableSelectedVehicle = selectedVehicle ? {
      type: selectedVehicle.type,
      label: selectedVehicle.label,
      available: selectedVehicle.available,
      eta: selectedVehicle.eta,
      price: selectedVehicle.price
    } : null;
    
    const state = {
      currentStep,
      dropLocation,
      dropCoordinates,
      fareEstimates,
      selectedVehicle: serializableSelectedVehicle,
      selectedDriver: selectedDriver ? {
        _id: selectedDriver._id,
        fullName: selectedDriver.fullName,
        mobileNo: selectedDriver.mobileNo,
        vehicleNo: selectedDriver.vehicleNo,
        vehicleType: selectedDriver.vehicleType,
        queuePosition: selectedDriver.queuePosition
      } : null,
      userPhone,
      userName,
      userEmail,
      existingUser,
      showRegistrationForm,
      showMap,
      timestamp: Date.now()
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  };

  const loadBookingState = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const state = JSON.parse(saved);
        // Check if state is less than 1 hour old
        if (Date.now() - state.timestamp < 3600000) {
          return state;
        }
      }
    } catch (error) {
      console.error('Error loading booking state:', error);
    }
    return null;
  };

  const clearBookingState = () => {
    localStorage.removeItem(STORAGE_KEY);
  };

  // NEW: Fetch pending FM requests on mount and periodically
  useEffect(() => {
    // Fetch pending FM requests on mount
    fetchPendingFmRequests();

    // Refresh every 30 seconds
    const interval = setInterval(fetchPendingFmRequests, 30000);

    return () => clearInterval(interval);
  }, []);

  // Initialize component and check for saved state
  useEffect(() => {
    const savedState = loadBookingState();
    if (savedState) {
      setShowRecoveryModal(true);
    }

    // Initialize socket for admin
    const initializeAdminSocket = async () => {
      const token = localStorage.getItem('adminToken');
      if (!token) {
        console.log('[ManualBooking] No admin token found');
        navigate('/admin/login');
        return;
      }
      
      try {
        console.log('[ManualBooking] Initializing socket...');
        const socketResult = initializeSocket(token);
        
        // Handle different return types from initializeSocket
        if (socketResult && typeof socketResult.then === 'function') {
          // It's a Promise
          const actualSocket = await socketResult;
          if (actualSocket) {
            console.log('[ManualBooking] Socket initialized successfully');
            setSocket(actualSocket);
            setSocketConnected(actualSocket.connected);
          } else {
            console.error('[ManualBooking] Failed to initialize socket (Promise returned null)');
          }
        } else if (socketResult) {
          // Direct socket instance
          console.log('[ManualBooking] Socket initialized successfully (direct)');
          setSocket(socketResult);
          setSocketConnected(socketResult.connected);
        } else {
          console.error('[ManualBooking] Socket initialization failed');
        }
      } catch (error) {
        console.error('[ManualBooking] Socket initialization error:', error);
      }
    };
    
    initializeAdminSocket();
    
    // Monitor socket connection
    const checkSocketConnection = () => {
      const socket = getSocket();
      const connected = socket && socket.connected;
      setSocketConnected(connected);
    };
    
    // Check immediately after a short delay to let initialization complete
    setTimeout(checkSocketConnection, 500);
    
    // Set up interval to check connection
    const connectionInterval = setInterval(checkSocketConnection, 2000);
    
    return () => clearInterval(connectionInterval);
  }, [navigate]);

  // Timer helper functions for 30-second request expiry
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback((expiresAt) => {
    clearTimer();
    const updateTimer = () => {
      const remaining = Math.max(0, Math.floor((new Date(expiresAt) - Date.now()) / 1000));
      setRequestTimer(remaining);
      if (remaining <= 0) {
        clearTimer();
        // IMMEDIATELY update status - don't wait for socket event
        setRequestStatus('expired');
        setActiveRequest(prev => prev ? {
          ...prev,
          expiredReason: 'Driver did not respond within time limit'
        } : null);
      }
    };
    updateTimer();
    timerRef.current = setInterval(updateTimer, 1000);
  }, [clearTimer]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  // Set up socket event listeners for ride acceptance/rejection
  useEffect(() => {
    if (!socket || !socketConnected) return;

    // Listen for driver accepting the ride
    const handleDriverAssigned = (data) => {
      console.log('🔔 [ManualBooking] driverAssigned event received:', data);

      // NEW: Check if this matches our active request (for Step 5 new UI)
      setActiveRequest(prevRequest => {
        if (prevRequest && data.bookingId === prevRequest.bookingId) {
          console.log('✅ [ManualBooking] Active request accepted!');
          clearTimer();
          setRequestStatus('accepted');
          // Update active request with OTP data
          return {
            ...prevRequest,
            startOTP: data.startOTP,
            endOTP: data.endOTP,
            queueNumber: data.queueNumber
          };
        }
        return prevRequest;
      });

      // Use functional update to get latest bookingDetails (for old flow compatibility)
      setBookingDetails(prev => {
        console.log('📋 [ManualBooking] Current bookingDetails:', prev);
        console.log('🔍 [ManualBooking] Comparing bookingIds:', {
          received: data.bookingId,
          current: prev?.bookingId,
          match: prev && data.bookingId === prev.bookingId
        });

        // Check if this is for our booking (use bookingId string comparison)
        if (prev && data.bookingId === prev.bookingId) {
          console.log('✅ [ManualBooking] BookingId matches! Updating state...');
          setWaitingForDriverResponse(false);
          return {
            ...prev,
            status: 'driver_accepted',
            driverName: data.driverName,
            driverId: data.driverId,
            startOTP: data.startOTP,
            endOTP: data.endOTP,
            queueNumber: data.queueNumber,
            message: 'Driver has accepted the ride!'
          };
        } else {
          console.log('❌ [ManualBooking] BookingId does not match, ignoring event');
          return prev;
        }
      });
    };

    // Listen for driver rejecting the ride
    const handleRideRejected = (data) => {
      console.log('🔔 [ManualBooking] rideRejectedByDriver event received:', data);

      // NEW: Check if this matches our active request (for Step 5 new UI)
      setActiveRequest(prevRequest => {
        if (prevRequest && data.bookingId === prevRequest.bookingId) {
          console.log('❌ [ManualBooking] Active request rejected!');
          clearTimer();
          setRequestStatus('rejected');
          return {
            ...prevRequest,
            rejectionReason: data.reason || 'Driver not available'
          };
        }
        return prevRequest;
      });

      // Use functional update to get latest bookingDetails (for old flow compatibility)
      setBookingDetails(prev => {
        // Check if this is for our booking (use bookingId string comparison)
        if (prev && data.bookingId === prev.bookingId) {
          setWaitingForDriverResponse(false);
          return {
            ...prev,
            status: 'driver_rejected',
            message: `Driver rejected the ride: ${data.reason || 'Driver not available'}`,
            rejectionReason: data.reason
          };
        }
        return prev;
      });
    };

    // Listen for ride cancellation (from driver or admin)
    const handleRideCancelled = (data) => {
      console.log('🔔 [ManualBooking] rideCancelled event received:', data);

      // Use functional update to get latest bookingDetails
      setBookingDetails(prev => {
        // Check if this is for our booking (match using _id, rideId, or uniqueRideId)
        const isOurBooking = prev && (
          data.rideId === prev._id ||
          data.rideId === prev.rideId ||
          data.uniqueRideId === prev.rideId ||
          data.bookingId === prev.bookingId
        );

        if (isOurBooking) {
          console.log('✅ [ManualBooking] Ride cancelled, clearing booking state');
          setWaitingForDriverResponse(false);

          const cancelledByText = data.cancelledBy === 'driver' ? 'Driver' : 'System';
          alert(`Ride cancelled by ${cancelledByText}: ${data.reason || 'No reason provided'}`);

          // Clear the booking details to remove from UI
          return null;
        }
        return prev;
      });
    };

    // NEW: Driver status change handlers for real-time driver list updates
    const handleDriverStatusChanged = (data) => {
      console.log('🔄 [ManualBooking] Driver status changed:', data);

      setAvailableDrivers(prevDrivers => {
        return prevDrivers.map(driver => {
          if (driver._id === data.driverId) {
            return {
              ...driver,
              isOnline: data.isOnline,
              inQueue: data.inQueue,
              queuePosition: data.queuePosition,
              connectionStatus: data.connectionStatus,
              lastActiveTime: data.lastActiveTime
            };
          }
          return driver;
        }).filter(driver => driver.inQueue || driver.isOnline); // Show drivers who are in queue OR online (match QueueManagement)
      });
    };

    const handleDriverNotReachable = (data) => {
      console.log('⚠️ [ManualBooking] Driver not reachable:', data);

      setAvailableDrivers(prevDrivers => {
        return prevDrivers.map(driver => {
          if (driver._id === data.driverId) {
            return {
              ...driver,
              isOnline: false,
              connectionStatus: 'disconnected',
              lastActiveTime: data.lastActiveTime
            };
          }
          return driver;
        });
      });
    };

    const handleDriverReconnected = (data) => {
      console.log('✅ [ManualBooking] Driver reconnected:', data);

      setAvailableDrivers(prevDrivers => {
        return prevDrivers.map(driver => {
          if (driver._id === data.driverId) {
            return {
              ...driver,
              isOnline: true,
              connectionStatus: 'connected',
              lastActiveTime: new Date().toISOString()
            };
          }
          return driver;
        });
      });
    };

    // Handler for driverStatusUpdated (same as QueueManagement)
    const handleDriverStatusUpdated = (data) => {
      console.log('📊 [ManualBooking] Driver status updated:', data);
      setAvailableDrivers(prevDrivers => {
        return prevDrivers.map(driver => {
          if (driver._id === data.driverId) {
            return {
              ...driver,
              isOnline: data.isOnline,
              inQueue: data.inQueue !== undefined ? data.inQueue : driver.inQueue,
              connectionStatus: data.connectionStatus || (data.isOnline ? 'connected' : 'offline'),
              queuePosition: data.queuePosition !== undefined ? data.queuePosition : driver.queuePosition,
              lastActiveTime: data.lastActiveTime || new Date()
            };
          }
          return driver;
        }).filter(driver => driver.inQueue || driver.isOnline);
      });
    };

    // Handler for driverOnline
    const handleDriverOnline = (data) => {
      console.log('🟢 [ManualBooking] Driver went online:', data);
      if (selectedVehicle?.type) {
        fetchAvailableDrivers(selectedVehicle.type);
      }
    };

    // Handler for driverOffline
    const handleDriverOffline = (data) => {
      console.log('🔴 [ManualBooking] Driver went offline:', data);
      setAvailableDrivers(prevDrivers => {
        return prevDrivers.map(driver => {
          if (driver._id === data.driverId) {
            return { ...driver, isOnline: false, connectionStatus: 'offline' };
          }
          return driver;
        }).filter(driver => driver.inQueue || driver.isOnline);
      });
    };

    // Handler for online request events (matching QueueManagement)
    const handleNewOnlineRequest = (data) => {
      console.log('📬 [ManualBooking] New online request:', data);
      setPendingRequests(prev => {
        if (prev.find(r => r._id === data.request?._id)) return prev;
        setPendingRequestsCount(count => count + 1);
        return [data.request, ...prev];
      });
    };

    const handleOnlineRequestProcessed = (data) => {
      console.log('✅ [ManualBooking] Online request processed:', data);
      setPendingRequests(prev => {
        const filtered = prev.filter(r => r._id !== data.requestId);
        if (filtered.length < prev.length) {
          setPendingRequestsCount(count => Math.max(0, count - 1));
        }
        return filtered;
      });
      if (data.status === 'approved' && selectedVehicle?.type) {
        fetchAvailableDrivers(selectedVehicle.type);
      }
    };

    const handleOnlineRequestCancelled = (data) => {
      console.log('❌ [ManualBooking] Online request cancelled:', data);
      setPendingRequests(prev => {
        const filtered = prev.filter(r => r._id !== data.requestId);
        if (filtered.length < prev.length) {
          setPendingRequestsCount(count => Math.max(0, count - 1));
        }
        return filtered;
      });
    };

    const handleApproveOnlineRequestResult = (data) => {
      console.log('✅ [ManualBooking] Approve request result:', data);
      if (data.success && data.request?._id) {
        setQueueSuccess(`${data.request?.driverName || 'Driver'} has been approved`);
        setPendingRequests(prev => {
          const filtered = prev.filter(r => r._id !== data.request._id);
          if (filtered.length < prev.length) {
            setPendingRequestsCount(count => Math.max(0, count - 1));
          }
          return filtered;
        });
        if (selectedVehicle?.type) fetchAvailableDrivers(selectedVehicle.type);
      } else if (!data.success) {
        setQueueError(data.error || 'Failed to approve request');
      }
      setProcessingRequestId(null);
      setTimeout(() => { setQueueError(''); setQueueSuccess(''); }, 3000);
    };

    const handleRejectOnlineRequestResult = (data) => {
      console.log('❌ [ManualBooking] Reject request result:', data);
      if (data.success && data.request?._id) {
        setQueueSuccess('Request has been rejected');
        setPendingRequests(prev => {
          const filtered = prev.filter(r => r._id !== data.request._id);
          if (filtered.length < prev.length) {
            setPendingRequestsCount(count => Math.max(0, count - 1));
          }
          return filtered;
        });
      } else if (!data.success) {
        setQueueError(data.error || 'Failed to reject request');
      }
      setProcessingRequestId(null);
      setTimeout(() => { setQueueError(''); setQueueSuccess(''); }, 3000);
    };

    // Handler for offline request events
    const handleNewOfflineRequest = (data) => {
      console.log('📬 [ManualBooking] New offline request:', data);
      setPendingOfflineRequests(prev => {
        if (prev.find(r => r._id === data.request?._id)) return prev;
        setPendingOfflineRequestsCount(count => count + 1);
        return [data.request, ...prev];
      });
    };

    const handleOfflineRequestProcessed = (data) => {
      console.log('✅ [ManualBooking] Offline request processed:', data);
      setPendingOfflineRequests(prev => {
        const filtered = prev.filter(r => r._id !== data.requestId);
        if (filtered.length < prev.length) {
          setPendingOfflineRequestsCount(count => Math.max(0, count - 1));
        }
        return filtered;
      });
      if (data.status === 'approved' && selectedVehicle?.type) {
        fetchAvailableDrivers(selectedVehicle.type);
      }
    };

    const handleApproveOfflineRequestResult = (data) => {
      console.log('✅ [ManualBooking] Approve offline request result:', data);
      if (data.success && data.request?._id) {
        setQueueSuccess(`${data.request?.driverName || 'Driver'} is now offline`);
        setPendingOfflineRequests(prev => {
          const filtered = prev.filter(r => r._id !== data.request._id);
          if (filtered.length < prev.length) {
            setPendingOfflineRequestsCount(count => Math.max(0, count - 1));
          }
          return filtered;
        });
        if (selectedVehicle?.type) fetchAvailableDrivers(selectedVehicle.type);
      } else if (!data.success) {
        setQueueError(data.error || 'Failed to approve offline request');
      }
      setProcessingRequestId(null);
      setTimeout(() => { setQueueError(''); setQueueSuccess(''); }, 3000);
    };

    const handleRejectOfflineRequestResult = (data) => {
      console.log('❌ [ManualBooking] Reject offline request result:', data);
      if (data.success && data.request?._id) {
        setQueueSuccess('Offline request has been rejected');
        setPendingOfflineRequests(prev => {
          const filtered = prev.filter(r => r._id !== data.request._id);
          if (filtered.length < prev.length) {
            setPendingOfflineRequestsCount(count => Math.max(0, count - 1));
          }
          return filtered;
        });
      } else if (!data.success) {
        setQueueError(data.error || 'Failed to reject offline request');
      }
      setProcessingRequestId(null);
      setTimeout(() => { setQueueError(''); setQueueSuccess(''); }, 3000);
    };

    const handleAdminRemoveFromQueueResult = (data) => {
      console.log('🗑️ [ManualBooking] Admin remove from queue result:', data);
      if (data.success) {
        setQueueSuccess(`${data.driverName || 'Driver'} has been removed from the queue`);
        if (selectedVehicle?.type) fetchAvailableDrivers(selectedVehicle.type);
      } else {
        setQueueError(data.error || 'Failed to remove driver from queue');
      }
      setTimeout(() => { setQueueError(''); setQueueSuccess(''); }, 3000);
    };

    // NEW: Handler for manual booking expiry (15-second timeout)
    const handleManualBookingExpired = (data) => {
      console.log('⏱️ [ManualBooking] Manual booking expired:', data);

      setActiveRequest(prevRequest => {
        if (prevRequest && data.bookingId === prevRequest.bookingId) {
          console.log('⏱️ [ManualBooking] Active request expired!');
          clearTimer();
          setRequestStatus('expired');
          return {
            ...prevRequest,
            expiredReason: data.message || 'No response in 15 seconds'
          };
        }
        return prevRequest;
      });
    };

    // NEW: Handler for driver tried to accept expired ride
    const handleDriverTriedExpiredRide = (data) => {
      console.log('⏱️ [ManualBooking] Driver tried expired ride:', data);
      // Just log - the expiry is already handled
    };

    // ============================================
    // NEW: Fleet Manager workflow socket handlers
    // ============================================

    // Handler for when Fleet Manager assigns driver and driver accepts
    const handleDriverAcceptedFmBooking = (data) => {
      console.log('✅ [ManualBooking] FM booking driver accepted:', data);

      // Check if this is our booking
      if (currentFmBooking && data.bookingId === currentFmBooking.bookingId) {
        // Update the current booking with OTPs and driver info
        setCurrentFmBooking(prev => ({
          ...prev,
          ...data,
          status: 'driver_assigned',
          driverName: data.driverName,
          driverPhone: data.driverPhone,
          vehicleNumber: data.vehicleNumber,
          startOTP: data.startOTP,
          endOTP: data.endOTP,
          queueNumber: data.queueNumber
        }));

        setFmStatus('assigned');

        // Show notification
        if (Notification.permission === 'granted') {
          new Notification('Driver Assigned!', {
            body: `Driver ${data.driverName} accepted your booking.`,
            icon: '/favicon.ico'
          });
        }
      }

      // Update pending requests list
      setPendingFmRequests(prev =>
        prev.map(r => r.bookingId === data.bookingId
          ? { ...r, status: 'driver_assigned', driverName: data.driverName }
          : r
        ).filter(r => r.status === 'pending_fm')
      );
    };

    // Handler for when Fleet Manager cancels a booking
    const handleFmCancelledRequest = (data) => {
      console.log('❌ [ManualBooking] FM cancelled request:', data);

      // Check if this is our booking
      if (currentFmBooking && data.bookingId === currentFmBooking.bookingId) {
        setCurrentFmBooking(prev => ({
          ...prev,
          status: 'cancelled_by_fm',
          cancellationReason: data.reason
        }));

        setFmStatus('cancelled');

        alert(`Fleet Manager cancelled your booking.\nReason: ${data.reason}`);
      }

      // Remove from pending list
      setPendingFmRequests(prev => prev.filter(r => r.bookingId !== data.bookingId));
    };

    // Handler for when driver rejects FM booking (back to FM queue)
    const handleDriverRejectedFmBooking = (data) => {
      console.log('🔄 [ManualBooking] FM booking driver rejected:', data);

      // Check if this is our booking
      if (currentFmBooking && data.bookingId === currentFmBooking.bookingId) {
        // Update status back to pending
        setCurrentFmBooking(prev => ({
          ...prev,
          status: 'pending_fm',
          targetDriver: null
        }));

        setFmStatus('pending');

        // Notify user
        alert(`Driver ${data.rejectedBy?.driverName || 'Unknown'} rejected the ride. Fleet Manager will assign another driver.`);
      }
    };

    console.log('🎧 [ManualBooking] Registering socket event listeners');
    socket.on('driverAssigned', handleDriverAssigned);
    socket.on('rideRejectedByDriver', handleRideRejected);
    socket.on('rideCancelled', handleRideCancelled);

    // Driver status changes
    socket.on('driverStatusChanged', handleDriverStatusChanged);
    socket.on('driverNotReachable', handleDriverNotReachable);
    socket.on('driverReconnected', handleDriverReconnected);
    socket.on('driverStatusUpdated', handleDriverStatusUpdated);
    socket.on('driverOnline', handleDriverOnline);
    socket.on('driverOffline', handleDriverOffline);

    // Online request events (for Queue Management functionality)
    socket.on('newOnlineRequest', handleNewOnlineRequest);
    socket.on('onlineRequestProcessed', handleOnlineRequestProcessed);
    socket.on('onlineRequestCancelled', handleOnlineRequestCancelled);
    socket.on('approveOnlineRequestResult', handleApproveOnlineRequestResult);
    socket.on('rejectOnlineRequestResult', handleRejectOnlineRequestResult);

    // Offline request events
    socket.on('newOfflineRequest', handleNewOfflineRequest);
    socket.on('offlineRequestProcessed', handleOfflineRequestProcessed);
    socket.on('approveOfflineRequestResult', handleApproveOfflineRequestResult);
    socket.on('rejectOfflineRequestResult', handleRejectOfflineRequestResult);

    // Admin queue management events
    socket.on('adminRemoveFromQueueResult', handleAdminRemoveFromQueueResult);

    // NEW: Manual booking expiry events
    socket.on('manualBookingExpired', handleManualBookingExpired);
    socket.on('driverTriedExpiredRide', handleDriverTriedExpiredRide);

    // NEW: Fleet Manager workflow events
    socket.on('driverAcceptedFmBooking', handleDriverAcceptedFmBooking);
    socket.on('fmCancelledRequest', handleFmCancelledRequest);
    socket.on('driverRejectedFmBooking', handleDriverRejectedFmBooking);

    return () => {
      console.log('🔇 [ManualBooking] Removing socket event listeners');
      socket.off('driverAssigned', handleDriverAssigned);
      socket.off('rideRejectedByDriver', handleRideRejected);
      socket.off('rideCancelled', handleRideCancelled);
      socket.off('driverStatusChanged', handleDriverStatusChanged);
      socket.off('driverNotReachable', handleDriverNotReachable);
      socket.off('driverReconnected', handleDriverReconnected);
      socket.off('driverStatusUpdated', handleDriverStatusUpdated);
      socket.off('driverOnline', handleDriverOnline);
      socket.off('driverOffline', handleDriverOffline);
      socket.off('newOnlineRequest', handleNewOnlineRequest);
      socket.off('onlineRequestProcessed', handleOnlineRequestProcessed);
      socket.off('onlineRequestCancelled', handleOnlineRequestCancelled);
      socket.off('approveOnlineRequestResult', handleApproveOnlineRequestResult);
      socket.off('rejectOnlineRequestResult', handleRejectOnlineRequestResult);
      socket.off('newOfflineRequest', handleNewOfflineRequest);
      socket.off('offlineRequestProcessed', handleOfflineRequestProcessed);
      socket.off('approveOfflineRequestResult', handleApproveOfflineRequestResult);
      socket.off('rejectOfflineRequestResult', handleRejectOfflineRequestResult);
      socket.off('adminRemoveFromQueueResult', handleAdminRemoveFromQueueResult);
      socket.off('manualBookingExpired', handleManualBookingExpired);
      socket.off('driverTriedExpiredRide', handleDriverTriedExpiredRide);
      // NEW: Fleet Manager workflow events cleanup
      socket.off('driverAcceptedFmBooking', handleDriverAcceptedFmBooking);
      socket.off('fmCancelledRequest', handleFmCancelledRequest);
      socket.off('driverRejectedFmBooking', handleDriverRejectedFmBooking);
    };
  }, [socket, socketConnected, selectedVehicle?.type, clearTimer, currentFmBooking]); // Added currentFmBooking dependency

  // Auto-save state when important fields change
  useEffect(() => {
    if (currentStep > 1 || dropLocation || userPhone) {
      saveBookingState();
    }
  }, [currentStep, dropLocation, dropCoordinates, fareEstimates, selectedVehicle, userPhone, userName, userEmail, existingUser, showRegistrationForm]);

  // Auto-refresh driver list every 30 seconds (matching QueueManagement)
  useEffect(() => {
    if (currentStep === 5 && selectedVehicle?.type) {
      // Initial fetch when entering step 5
      fetchAvailableDrivers(selectedVehicle.type);
      fetchPendingRequests();
      fetchPendingOfflineRequests();

      // Auto-refresh every 30 seconds
      const refreshInterval = setInterval(() => {
        console.log('🔄 [ManualBooking] Auto-refreshing driver list...');
        fetchAvailableDrivers(selectedVehicle.type);
        fetchPendingRequests();
        fetchPendingOfflineRequests();
      }, 30000);

      return () => clearInterval(refreshInterval);
    }
  }, [currentStep, selectedVehicle?.type]);

  // Fetch pending online requests (matching QueueManagement)
  const fetchPendingRequests = async () => {
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
        const requests = data.requests || [];
        setPendingRequests(requests);
        setPendingRequestsCount(requests.length);
      }
    } catch (err) {
      console.error('[ManualBooking] Error fetching pending requests:', err);
    }
  };

  // Fetch pending offline requests
  const fetchPendingOfflineRequests = async () => {
    try {
      const token = localStorage.getItem('adminToken');
      const response = await fetch(`${process.env.REACT_APP_API_URL || 'http://localhost:5000/api'}/admin/offline-requests`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();

      if (data.success) {
        const requests = data.requests || [];
        setPendingOfflineRequests(requests);
        setPendingOfflineRequestsCount(requests.length);
      }
    } catch (err) {
      console.error('[ManualBooking] Error fetching pending offline requests:', err);
    }
  };

  // Queue Management Handlers (matching QueueManagement)

  // Approve online request
  const handleApproveRequest = async (requestId) => {
    setProcessingRequestId(requestId);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('approveOnlineRequest', { requestId });
      }
    } catch (err) {
      setQueueError('Failed to approve request');
      setProcessingRequestId(null);
      setTimeout(() => setQueueError(''), 3000);
    }
  };

  // Reject online request
  const handleRejectRequest = async (requestId, reason = '') => {
    setProcessingRequestId(requestId);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('rejectOnlineRequest', { requestId, reason });
      }
    } catch (err) {
      setQueueError('Failed to reject request');
      setProcessingRequestId(null);
      setTimeout(() => setQueueError(''), 3000);
    }
  };

  // Approve offline request
  const handleApproveOfflineRequest = async (requestId) => {
    setProcessingRequestId(requestId);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('approveOfflineRequest', { requestId });
      }
    } catch (err) {
      setQueueError('Failed to approve offline request');
      setProcessingRequestId(null);
      setTimeout(() => setQueueError(''), 3000);
    }
  };

  // Reject offline request
  const handleRejectOfflineRequest = async (requestId, reason = '') => {
    setProcessingRequestId(requestId);
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('rejectOfflineRequest', { requestId, reason });
      }
    } catch (err) {
      setQueueError('Failed to reject offline request');
      setProcessingRequestId(null);
      setTimeout(() => setQueueError(''), 3000);
    }
  };

  // Remove driver from queue (Admin-Only Queue Management)
  const handleRemoveFromQueue = async (driverId, driverName) => {
    try {
      const socket = getSocket();
      if (socket) {
        socket.emit('adminRemoveFromQueue', {
          driverId,
          reason: 'Admin removed from queue via Manual Booking'
        });
      }
    } catch (err) {
      setQueueError('Failed to remove driver from queue');
      setTimeout(() => setQueueError(''), 3000);
    }
  };

  // Refresh driver list manually
  const handleRefreshDrivers = () => {
    if (selectedVehicle?.type) {
      fetchAvailableDrivers(selectedVehicle.type);
      fetchPendingRequests();
      fetchPendingOfflineRequests();
      setQueueSuccess('Driver list refreshed');
      setTimeout(() => setQueueSuccess(''), 2000);
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

  // Calculate fare estimates automatically when drop location changes
  const calculateFareEstimates = async () => {
    if (!dropCoordinates) return;

    setIsCalculatingFare(true);
    setIsCalculatingRoute(true);
    setRouteError(null);
    setDirections(null);

    // Step 1: Get actual road distance + route polyline via DirectionsService
    let roadDistanceKm = null;

    await new Promise((resolve) => {
      if (!window.google?.maps?.DirectionsService) {
        setIsCalculatingRoute(false);
        resolve();
        return;
      }
      const directionsService = new window.google.maps.DirectionsService();
      directionsService.route(
        {
          origin: { lat: currentBooth.lat, lng: currentBooth.lng },
          destination: { lat: dropCoordinates.lat, lng: dropCoordinates.lng },
          travelMode: window.google.maps.TravelMode.DRIVING,
          drivingOptions: { departureTime: new Date(), trafficModel: 'bestguess' },
        },
        (result, status) => {
          setIsCalculatingRoute(false);
          if (status === 'OK' && result) {
            setDirections(result);
            const meters = result.routes[0]?.legs[0]?.distance?.value || 0;
            roadDistanceKm = parseFloat((meters / 1000).toFixed(2));
            console.log('Road distance from Directions API:', roadDistanceKm, 'km');
          } else {
            console.warn('DirectionsService failed:', status, '— falling back to Haversine');
            setRouteError(`Route unavailable (${status}). Distance calculated using straight-line estimate.`);
          }
          resolve();
        }
      );
    });

    // Step 2: Call fare estimate API — pass road distance if available
    try {
      const fareData = {
        pickupLat: currentBooth.lat,
        pickupLng: currentBooth.lng,
        dropLat: dropCoordinates.lat,
        dropLng: dropCoordinates.lng,
        pickupStation: currentBooth.name,
        ...(roadDistanceKm !== null && { distance: roadDistanceKm }),
      };

      console.log('Calculating fare with data:', fareData);
      const response = await admin.getFareEstimate(fareData);

      if (response.success) {
        setFareEstimates(response);
        console.log('Fare estimates received:', response);
      } else {
        console.error('Fare estimation failed:', response.message);
        alert('Could not calculate fare. Please check the location and try again.');
      }
    } catch (error) {
      console.error('Error calculating fare:', error);
      alert('Failed to calculate fare. Please try again.');
    } finally {
      setIsCalculatingFare(false);
    }
  };

  // Calculate fare only when location is confirmed
  useEffect(() => {
    if (dropCoordinates && dropLocationConfirmed) {
      calculateFareEstimates();
    }
  }, [dropCoordinates, dropLocationConfirmed]);

  // Google Maps is already loaded by App.js LoadScript
  // Check if it's available and set state accordingly
  useEffect(() => {
    const checkMapsAvailability = () => {
      if (window.google && window.google.maps && window.google.maps.places) {
        console.log('Google Maps API is available');
        setMapsLoaded(true);
        setMapsError(false);
      } else {
        console.warn('Google Maps API not yet available, retrying...');
        setTimeout(checkMapsAvailability, 1000);
      }
    };
    
    // Start checking after a brief delay
    const timer = setTimeout(checkMapsAvailability, 500);
    
    // Set a maximum timeout
    const maxTimer = setTimeout(() => {
      if (!mapsLoaded) {
        console.error('Google Maps API failed to load within timeout');
        setMapsError(true);
      }
    }, 10000);
    
    return () => {
      clearTimeout(timer);
      clearTimeout(maxTimer);
    };
  }, [mapsLoaded]);

  // Google Places Autocomplete handlers (like user booking)
  const onAutocompleteLoad = (autoComplete) => {
    console.log('Autocomplete loaded:', autoComplete);
    setAutocomplete(autoComplete);
    setMapsLoaded(true);
  };

  const onPlaceChanged = () => {
    if (autocomplete !== null) {
      const place = autocomplete.getPlace();
      console.log('Place selected:', place);
      
      if (place.geometry) {
        const address = place.formatted_address || place.name;
        const coordinates = {
          lat: place.geometry.location.lat(),
          lng: place.geometry.location.lng()
        };
        
        console.log('Setting drop location:', { address, coordinates });
        setDropLocation(address);
        setDropCoordinates(coordinates);
        setDropLocationConfirmed(false); // Reset confirmation when location changes
        setDirections(null);
        setRouteError(null);

        // Always show map when drop location is selected
        if (!showMap) {
          setShowMap(true);
        }
        
        // Center map on the selected location and fit both markers
        setTimeout(() => {
          if (mapInstance && currentBooth) {
            const bounds = new window.google.maps.LatLngBounds();
            bounds.extend({ lat: currentBooth.lat, lng: currentBooth.lng });
            bounds.extend(coordinates);
            mapInstance.fitBounds(bounds);
            
            // Add some padding
            const padding = { top: 50, right: 50, bottom: 50, left: 50 };
            mapInstance.fitBounds(bounds, padding);
          } else if (mapInstance) {
            mapInstance.panTo(coordinates);
            mapInstance.setZoom(15);
          }
        }, 100); // Small delay to ensure map is rendered
        
        // Don't calculate fare immediately - wait for confirmation
        // Fare calculation will be triggered when user confirms location
      } else {
        console.warn('No geometry data for selected place');
        alert('Please select a valid location from the dropdown');
      }
    }
  };

  // Handle map click for drop location selection
  const handleMapClick = (event) => {
    const coordinates = {
      lat: event.latLng.lat(),
      lng: event.latLng.lng()
    };
    setDropCoordinates(coordinates);
    setDropLocationConfirmed(false); // Reset confirmation when location changes
    setDirections(null);
    setRouteError(null);

    // Reverse geocode to get address
    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ location: coordinates }, (results, status) => {
      if (status === 'OK' && results[0]) {
        setDropLocation(results[0].formatted_address);
        console.log('Address set from map click:', results[0].formatted_address);
      } else {
        setDropLocation(`Location: ${coordinates.lat.toFixed(4)}, ${coordinates.lng.toFixed(4)}`);
      }
    });
  };

  // Handle marker drag end
  const handleMarkerDragEnd = (event) => {
    const coordinates = {
      lat: event.latLng.lat(),
      lng: event.latLng.lng()
    };
    setDropCoordinates(coordinates);
    setDropLocationConfirmed(false); // Reset confirmation when location changes
    setDirections(null);
    setRouteError(null);

    // Reverse geocode to get address
    const geocoder = new window.google.maps.Geocoder();
    geocoder.geocode({ location: coordinates }, (results, status) => {
      if (status === 'OK' && results[0]) {
        setDropLocation(results[0].formatted_address);
        console.log('Address updated from marker drag:', results[0].formatted_address);
      } else {
        setDropLocation(`Location: ${coordinates.lat.toFixed(4)}, ${coordinates.lng.toFixed(4)}`);
      }
    });
  };

  // Handle map load
  const onMapLoad = (map) => {
    setMapInstance(map);
    console.log('Map loaded successfully');
  };


  // Step navigation functions
  const nextStep = () => {
    if (currentStep < 6) setCurrentStep(currentStep + 1);
  };

  const prevStep = () => {
    if (currentStep > 1) setCurrentStep(currentStep - 1);
  };

  // Handle location step submission
  const handleLocationSubmit = () => {
    if (!dropLocation || !dropCoordinates) {
      alert('Please select a valid drop location');
      return;
    }
    
    // If location is not confirmed yet, confirm it now
    if (!dropLocationConfirmed) {
      setDropLocationConfirmed(true);
      // Fare calculation will trigger via useEffect
      return;
    }
    
    // If confirmed and fare is calculated, proceed
    if (!fareEstimates) {
      alert('Please wait for fare calculation to complete');
      return;
    }
    
    nextStep();
  };

  // Handle phone lookup - auto-triggers when phone is 10 digits
  const handlePhoneLookup = async (phone) => {
    if (phone.length !== 10) {
      return;
    }

    setIsLookingUpCustomer(true);
    try {
      const response = await admin.checkUserByPhone(phone);
      if (response.exists) {
        // Customer found - display their info
        setExistingUser(response.user);
        setUserName(response.user.name);
        setUserEmail(response.user.email || '');
        setShowRegistrationForm(false);
      } else {
        // Customer not found - show registration form
        setExistingUser(null);
        setUserName('');
        setUserEmail('');
        setShowRegistrationForm(true);
      }
    } catch (error) {
      console.error('Error checking user:', error);
      toast.error('Failed to check customer details');
    } finally {
      setIsLookingUpCustomer(false);
    }
  };

  // Handle customer registration
  const handleRegisterCustomer = async () => {
    if (!userName || !userPhone) {
      toast.error('Please enter customer name and phone number');
      return;
    }

    if (userPhone.length !== 10) {
      toast.error('Please enter a valid 10-digit phone number');
      return;
    }

    setIsRegisteringCustomer(true);
    try {
      // Register the customer
      const response = await admin.registerCustomer({
        phone: userPhone,
        name: userName,
        email: userEmail || undefined
      });

      if (response.success) {
        // Immediately fetch from database to verify
        const verifyResponse = await admin.checkUserByPhone(userPhone);
        if (verifyResponse.exists) {
          setExistingUser(verifyResponse.user);
          setShowRegistrationForm(false);
          toast.success('Customer registered successfully!');
        }
      }
    } catch (error) {
      console.error('Error registering customer:', error);
      toast.error(error.response?.data?.message || 'Failed to register customer');
    } finally {
      setIsRegisteringCustomer(false);
    }
  };

  // Handle proceeding to next step (only when customer is confirmed)
  const handleProceedFromCustomer = () => {
    if (!existingUser) {
      toast.error('Please complete customer registration first');
      return;
    }
    nextStep();
  };

  // Handle vehicle selection
  const handleVehicleSelection = (vehicleType) => {
    const vehicleOptions = getVehicleOptions();
    const vehicle = vehicleOptions.find(v => v.type === vehicleType);
    setSelectedVehicle(vehicle);
    // Proceed to driver selection instead of final confirmation
    fetchAvailableDrivers(vehicleType);
    nextStep();
  };

  // Fetch available drivers from queue
  const fetchAvailableDrivers = async (vehicleType) => {
    setLoadingDrivers(true);
    setDriverError('');

    try {
      console.log('🔍 [ManualBooking] Fetching drivers for vehicle type:', vehicleType);

      // Fetch all drivers and filter by queue membership and vehicle type
      const response = await admin.getAllDrivers();
      const allDrivers = response.data || [];
      console.log('📦 [ManualBooking] Total drivers from API:', allDrivers.length);

      // Filter drivers in queue (both online and not reachable)
      // NEW: Use inQueue instead of isOnline to show disconnected drivers too
      const inQueueDrivers = allDrivers.filter(driver => driver.inQueue || driver.isOnline);
      console.log('🎯 [ManualBooking] Drivers in queue (inQueue OR isOnline):', inQueueDrivers.length);

      // Filter by vehicle type
      const vehicleMatchDrivers = inQueueDrivers.filter(driver => {
        return !vehicleType || driver.vehicleType === vehicleType;
      });
      console.log('🚗 [ManualBooking] Vehicle match drivers:', vehicleMatchDrivers.length, `(type: ${vehicleType})`);

      // Filter by current ride status
      const availableDrivers = vehicleMatchDrivers.filter(driver => {
        return !driver.currentRide;
      });
      console.log('✅ [ManualBooking] Available drivers (no currentRide):', availableDrivers.length);

      // Sort by: 1) Connected drivers first, 2) Then by queue entry time/position
      const sortedDrivers = availableDrivers.sort((a, b) => {
        // Priority 1: Connected drivers first (most important for successful booking)
        const aConnected = a.connectionStatus === 'connected' || (a.isOnline && !a.connectionStatus);
        const bConnected = b.connectionStatus === 'connected' || (b.isOnline && !b.connectionStatus);

        if (aConnected && !bConnected) return -1; // a is connected, b is not -> a first
        if (!aConnected && bConnected) return 1;  // b is connected, a is not -> b first

        // Priority 2: For drivers with same connection status, sort by queue entry time
        if (a.queueEntryTime && b.queueEntryTime) {
          return new Date(a.queueEntryTime) - new Date(b.queueEntryTime);
        }
        if (a.lastActiveTime && b.lastActiveTime) {
          return new Date(a.lastActiveTime) - new Date(b.lastActiveTime);
        }
        return (a.queuePosition || 999) - (b.queuePosition || 999);
      });

      // Reassign queue positions based on sorted order
      const finalDrivers = sortedDrivers.map((driver, index) => ({
        ...driver,
        queuePosition: index + 1
      }));
      console.log('📊 [ManualBooking] Final sorted drivers:', finalDrivers.length);

      setAvailableDrivers(finalDrivers);

      if (finalDrivers.length === 0) {
        console.warn('⚠️ [ManualBooking] No available drivers found, attempting fallback...');

        // Fallback to all drivers in queue
        const fallbackDrivers = inQueueDrivers
          .filter(driver => !driver.currentRide)
          .sort((a, b) => {
            if (a.queueEntryTime && b.queueEntryTime) {
              return new Date(a.queueEntryTime) - new Date(b.queueEntryTime);
            }
            if (a.lastActiveTime && b.lastActiveTime) {
              return new Date(a.lastActiveTime) - new Date(b.lastActiveTime);
            }
            return (a.queuePosition || 999) - (b.queuePosition || 999);
          })
          .map((driver, index) => ({
            ...driver,
            queuePosition: index + 1,
            isVehicleTypeMismatch: driver.vehicleType !== vehicleType
          }));

        console.log('🔄 [ManualBooking] Fallback drivers found:', fallbackDrivers.length);

        if (fallbackDrivers.length > 0) {
          setAvailableDrivers(fallbackDrivers);
          setDriverError(`No ${vehicleType} drivers available. Showing all drivers in queue.`);
        } else {
          // If still no drivers found, show helpful error message with detailed analysis
          const reasons = [];
          if (allDrivers.length === 0) reasons.push('No drivers in database');
          else if (inQueueDrivers.length === 0) reasons.push('No drivers in queue');
          else reasons.push('All drivers busy');

          console.error('❌ [ManualBooking] No drivers available. Analysis:');
          console.table(allDrivers.slice(0, 10).map(d => ({
            name: d.fullName,
            inQueue: d.inQueue,
            isOnline: d.isOnline,
            vehicleType: d.vehicleType,
            hasCurrentRide: !!d.currentRide,
            currentMetroBooth: d.currentMetroBooth
          })));

          setDriverError(`No drivers available: ${reasons.join(', ')}`);
        }
      }

    } catch (error) {
      console.error('❌ [ManualBooking] Error fetching drivers:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        stack: error.stack
      });
      setDriverError(`Failed to load available drivers: ${error.response?.data?.message || error.message}`);
    } finally {
      setLoadingDrivers(false);
    }
  };

  // Handle driver selection
  const handleDriverSelection = (driver) => {
    // Check if driver is disconnected (in queue but not reachable)
    if (driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue)) {
      // Show warning modal
      setDisconnectedDriverForWarning(driver);
      setShowDisconnectedWarning(true);
      return;
    }

    setSelectedDriver(driver);
    nextStep(); // Proceed to final confirmation
  };

  // Confirm selecting disconnected driver after warning
  const confirmDisconnectedDriverSelection = () => {
    if (disconnectedDriverForWarning) {
      setSelectedDriver(disconnectedDriverForWarning);
      setShowDisconnectedWarning(false);
      setDisconnectedDriverForWarning(null);
      nextStep();
    }
  };

  // Cancel selecting disconnected driver
  const cancelDisconnectedDriverSelection = () => {
    setShowDisconnectedWarning(false);
    setDisconnectedDriverForWarning(null);
  };

  // Handle auto-assignment (prefer first connected driver)
  const handleAutoAssignment = () => {
    if (availableDrivers.length > 0) {
      // Find first connected driver (drivers are already sorted with connected first)
      const firstConnectedDriver = availableDrivers.find(d =>
        d.connectionStatus === 'connected' || (d.isOnline && !d.connectionStatus)
      );

      if (firstConnectedDriver) {
        setSelectedDriver(firstConnectedDriver);
        nextStep();
      } else {
        // No connected drivers - warn user
        alert('No connected drivers available. All drivers in queue are "Not Reachable". Please wait for a driver to reconnect or manually select a driver.');
      }
    } else {
      alert('No drivers available for auto-assignment');
    }
  };

  // NEW: Handle sending request directly to a driver (Step 5 new UI)
  const handleSendRequest = async (driver) => {
    // Validate form is complete
    if (!dropLocation || !dropCoordinates) {
      alert('Please select a drop location');
      return;
    }
    if (!selectedVehicle) {
      alert('Please select a vehicle type');
      return;
    }
    if (!existingUser) {
      alert('Please complete customer verification first');
      return;
    }

    // If there's a pending request, ask to cancel first
    if (requestStatus === 'waiting' && activeRequest) {
      if (!window.confirm(`Cancel request to ${activeRequest.driverName} and send to ${driver.fullName}?`)) {
        return;
      }
      await handleCancelPendingRequest();
    }

    // Warn if driver is disconnected
    if (driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue)) {
      if (!window.confirm(`${driver.fullName} is not reachable. They may not receive the notification. Continue anyway?`)) {
        return;
      }
    }

    setRequestStatus('sending');

    try {
      const bookingData = {
        pickupStation: currentBooth.name,
        pickupLocation: currentBooth.name,
        dropLocation: dropLocation,
        vehicleType: selectedVehicle.type,
        estimatedFare: selectedVehicle.price,
        distance: fareEstimates?.distance || 0,
        userPhone: userPhone,
        userName: userName,
        existingUserId: existingUser?._id || null,
        selectedDriverId: driver._id,
        bookingSource: 'manual',
        paymentStatus: paymentMode === 'cash' ? 'collected' : 'online',
        paymentMethod: paymentMode === 'cash' ? 'cash' : 'upi',
        // Send fare breakdown to backend to avoid recalculation mismatch
        fareBreakdown: fareEstimates?.estimates?.[selectedVehicle.type] ? {
          customerTotalFare: fareEstimates.estimates[selectedVehicle.type].customerTotalFare,
          driverFare: fareEstimates.estimates[selectedVehicle.type].driverFare,
          platformEarning: fareEstimates.estimates[selectedVehicle.type].platformEarning,
          isNightCharge: fareEstimates.estimates[selectedVehicle.type].isNightCharge || false,
          nightChargeUserAmount: fareEstimates.estimates[selectedVehicle.type].nightChargeUserAmount || 0,
          nightChargeDriverAmount: fareEstimates.estimates[selectedVehicle.type].nightChargeDriverAmount || 0,
        } : null
      };

      const response = await admin.createManualBooking(bookingData);

      if (response.success) {
        const booking = response.booking;
        const expiresAt = new Date(Date.now() + 60 * 1000); // 60 seconds (1 minute) from now

        // Show warning if driver was not notified (they're disconnected)
        if (response.warning || response.driverNotified === false) {
          console.warn('⚠️ Driver notification warning:', response.warning);
          // Alert user about the warning but continue with the request
          alert(`⚠️ ${response.warning || 'Driver may not receive notification - they appear to be disconnected. Request will wait for them to reconnect.'}`);
        }

        setActiveRequest({
          rideId: booking._id,
          bookingId: booking.bookingId,
          driverId: driver._id,
          driverName: driver.fullName,
          driverPhone: driver.mobileNo,
          driverVehicle: driver.vehicleNo,
          sentAt: new Date(),
          expiresAt: expiresAt,
          startOTP: booking.startOTP,
          endOTP: booking.endOTP,
          driverNotified: response.driverNotified !== false // Track if driver was notified
        });

        setRequestStatus('waiting');
        startTimer(expiresAt);
      } else {
        throw new Error(response.message || 'Booking failed');
      }
    } catch (error) {
      console.error('Error sending request:', error);
      setRequestStatus('failed');
      setActiveRequest({
        driverName: driver.fullName,
        errorMessage: error.response?.data?.message || error.message || 'Failed to send request'
      });
    }
  };

  // NEW: Handle canceling pending request
  const handleCancelPendingRequest = async () => {
    if (!activeRequest?.rideId) return;

    // If already expired on client side, just reset UI without calling API
    if (requestStatus === 'expired' || requestTimer <= 0) {
      clearTimer();
      setRequestStatus('none');
      setActiveRequest(null);
      return;
    }

    try {
      await admin.cancelPendingBooking(activeRequest.rideId, 'Admin switched to another driver');
      clearTimer();
      setRequestStatus('none');
      setActiveRequest(null);
    } catch (error) {
      console.error('Error canceling request:', error);
      // If cancel fails (likely already expired on server), just reset UI
      clearTimer();
      setRequestStatus('none');
      setActiveRequest(null);
    }
  };

  // NEW: Reset request state for new booking
  const resetRequestState = () => {
    clearTimer();
    setRequestStatus('none');
    setActiveRequest(null);
  };

  // Handle resend OTP
  const handleResendOTP = async () => {
    if (!bookingDetails?._id) {
      alert('No booking found to resend OTP');
      return;
    }

    setIsResendingOTP(true);
    try {
      const token = localStorage.getItem('adminToken');
      const response = await fetch(`/api/admin/resend-otp/${bookingDetails._id}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (data.success) {
        alert(`✅ OTP resent successfully to ${data.phone}`);
      } else {
        alert(`❌ Failed to resend OTP: ${data.message}`);
      }
    } catch (error) {
      console.error('Error resending OTP:', error);
      alert('❌ Error resending OTP. Please try again.');
    } finally {
      setIsResendingOTP(false);
    }
  };

  // Handle payment collected - Submit to Fleet Manager for driver assignment
  const handlePaymentCollected = () => {
    // Submit to Fleet Manager (new flow)
    submitToFleetManager();
  };

  // State recovery functions
  const restoreBookingState = () => {
    const savedState = loadBookingState();
    if (savedState) {
      setCurrentStep(savedState.currentStep);
      setDropLocation(savedState.dropLocation);
      setDropCoordinates(savedState.dropCoordinates);
      setFareEstimates(savedState.fareEstimates);
      setUserPhone(savedState.userPhone || '');
      setUserName(savedState.userName || '');
      setUserEmail(savedState.userEmail || '');
      setShowRegistrationForm(savedState.showRegistrationForm || false);

      // Restore selectedVehicle by recreating it with icons
      if (savedState.selectedVehicle) {
        const restoredVehicle = findVehicleByType(savedState.selectedVehicle.type);
        setSelectedVehicle(restoredVehicle);
      } else {
        setSelectedVehicle(null);
      }
      
      setUserPhone(savedState.userPhone);
      setUserName(savedState.userName);
      
      // Restore selected driver
      if (savedState.selectedDriver) {
        setSelectedDriver(savedState.selectedDriver);
      }
      setExistingUser(savedState.existingUser);
      setShowMap(savedState.showMap || false);
    }
    setShowRecoveryModal(false);
  };

  const startFreshBooking = () => {
    clearBookingState();
    setShowRecoveryModal(false);
    resetForm();
  };

  // Final booking confirmation using standard user booking API
  const confirmBooking = async () => {
    debugger; // DEBUGGER 1: Entry point
    console.log('🚀 [Manual Booking] confirmBooking function called');
    console.log('📊 [Manual Booking] Current state:', {
      selectedDriver,
      selectedVehicle,
      userName,
      userPhone,
      dropLocation,
      socketConnected,
      socketExists: !!socket
    });
    
    // Add comprehensive validation and debugging
    try {
      setLoading(true);
      console.log('🔍 [Manual Booking] Setting loading to true');
      
      // Show initial loading message
      setBookingDetails({
        status: 'creating',
        message: 'Creating ride booking...',
        selectedDriver: selectedDriver
      });
      
      // Validate all required data before making API call
      console.log('🔍 [Manual Booking] Validating booking data...');
      
      if (!currentBooth?.name) {
        throw new Error('Pickup station is missing');
      }
      
      if (!dropLocation) {
        throw new Error('Drop location is missing');
      }
      
      if (!selectedVehicle?.type) {
        throw new Error('Vehicle type is missing');
      }
      
      if (!selectedVehicle?.price) {
        throw new Error('Vehicle price is missing');
      }
      
      // Enhanced phone validation
      if (!userPhone) {
        throw new Error('User phone is missing');
      }
      
      if (userPhone.length !== 10) {
        throw new Error('Phone number must be exactly 10 digits');
      }
      
      // Validate phone number format (should start with 6-9)
      const phoneRegex = /^[6-9]\d{9}$/;
      if (!phoneRegex.test(userPhone)) {
        throw new Error('Invalid phone number format. Must be 10 digits starting with 6-9');
      }
      
      if (!userName) {
        throw new Error('User name is missing');
      }

      // Prepare data for manual booking API
      const bookingData = {
        pickupStation: currentBooth.name,
        pickupLocation: currentBooth.name,
        dropLocation: dropLocation,
        vehicleType: selectedVehicle.type,
        estimatedFare: selectedVehicle.price,
        distance: fareEstimates?.distance || 0,
        userPhone: userPhone,
        userName: userName,
        existingUserId: existingUser?._id || null,
        selectedDriverId: selectedDriver?._id || null,
        bookingSource: 'manual',
        paymentStatus: paymentMode === 'cash' ? 'collected' : 'online',
        paymentMethod: paymentMode === 'cash' ? 'cash' : 'upi',
        // Send fare breakdown to backend to avoid recalculation mismatch
        fareBreakdown: fareEstimates?.estimates?.[selectedVehicle.type] ? {
          customerTotalFare: fareEstimates.estimates[selectedVehicle.type].customerTotalFare,
          driverFare: fareEstimates.estimates[selectedVehicle.type].driverFare,
          platformEarning: fareEstimates.estimates[selectedVehicle.type].platformEarning,
          isNightCharge: fareEstimates.estimates[selectedVehicle.type].isNightCharge || false,
          nightChargeUserAmount: fareEstimates.estimates[selectedVehicle.type].nightChargeUserAmount || 0,
          nightChargeDriverAmount: fareEstimates.estimates[selectedVehicle.type].nightChargeDriverAmount || 0,
        } : null
      };

      const response = await admin.createManualBooking(bookingData);

      if (response.success) {
        // Set waiting state and store booking details
        setWaitingForDriverResponse(true);
        setBookingDetails({
          ...response.booking,
          startOTP: response.booking.startOTP,
          endOTP: response.booking.endOTP,
          status: 'waiting_driver',
          message: 'Waiting for driver to accept the ride...',
          selectedDriver: selectedDriver,
          vehicleInfo: selectedVehicle,
          pickupLocation: currentBooth,
          dropLocation: { address: dropLocation }
        });

        // Clear saved state on successful booking
        clearBookingState();
      } else {
        throw new Error(response.message || 'Booking failed - unknown reason');
      }
    } catch (error) {
      console.error('[Manual Booking] Error:', error.message || error);
      
      // More detailed error handling
      let errorMessage = 'Failed to book ride';
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      // Show specific error messages
      if (errorMessage.includes('not available') || errorMessage.includes('no driver')) {
        setBookingDetails({
          status: 'no_drivers',
          message: '⚠️ No drivers available for the selected vehicle type. Please try a different vehicle type or wait a few minutes.',
          vehicleInfo: selectedVehicle,
          pickupLocation: currentBooth,
          dropLocation: { address: dropLocation }
        });
      } else if (errorMessage.includes('not online') || errorMessage.includes('not reachable')) {
        setBookingDetails({
          status: 'driver_offline',
          message: `⚠️ ${errorMessage}\n\nPlease check Queue Management to ensure the driver is online, then try again.`,
          vehicleInfo: selectedVehicle,
          pickupLocation: currentBooth,
          dropLocation: { address: dropLocation },
          selectedDriver: selectedDriver
        });
      } else {
        alert(`Booking failed: ${errorMessage}`);
      }
    } finally {
      setLoading(false);
    }
  };;

  // NEW: Submit booking to Fleet Manager for driver assignment
  const submitToFleetManager = async () => {
    console.log('🚀 [Manual Booking] submitToFleetManager function called');

    try {
      setLoading(true);
      setFmStatus('submitting');

      // Validate all required data
      if (!currentBooth?.name) {
        throw new Error('Pickup station is missing');
      }

      if (!dropLocation) {
        throw new Error('Drop location is missing');
      }

      if (!selectedVehicle?.type) {
        throw new Error('Vehicle type is missing');
      }

      if (!userPhone || userPhone.length !== 10) {
        throw new Error('Valid phone number is required');
      }

      const phoneRegex = /^[6-9]\d{9}$/;
      if (!phoneRegex.test(userPhone)) {
        throw new Error('Invalid phone number format');
      }

      if (!userName) {
        throw new Error('Customer name is missing');
      }

      // Prepare data for Fleet Manager submission
      const bookingData = {
        pickupStation: currentBooth.name,
        pickupLocation: currentBooth.name,
        dropLocation: dropLocation,
        dropCoordinates: dropCoordinates,
        vehicleType: selectedVehicle.type,
        estimatedFare: selectedVehicle.price,
        distance: fareEstimates?.distance || 0,
        userPhone: userPhone,
        userName: userName,
        existingUserId: existingUser?._id || null,
        paymentStatus: paymentMode === 'cash' ? 'collected' : 'online',
        paymentMethod: paymentMode === 'cash' ? 'cash' : 'upi',
        // Send fare breakdown to backend to avoid recalculation mismatch
        fareBreakdown: fareEstimates?.estimates?.[selectedVehicle.type] ? {
          customerTotalFare: fareEstimates.estimates[selectedVehicle.type].customerTotalFare,
          driverFare: fareEstimates.estimates[selectedVehicle.type].driverFare,
          platformEarning: fareEstimates.estimates[selectedVehicle.type].platformEarning,
          isNightCharge: fareEstimates.estimates[selectedVehicle.type].isNightCharge || false,
          nightChargeUserAmount: fareEstimates.estimates[selectedVehicle.type].nightChargeUserAmount || 0,
          nightChargeDriverAmount: fareEstimates.estimates[selectedVehicle.type].nightChargeDriverAmount || 0,
        } : null
      };

      console.log('📤 [Manual Booking] Submitting to Fleet Manager:', bookingData);

      const response = await admin.submitToFleetManager(bookingData);

      if (response.success) {
        console.log('✅ [Manual Booking] Successfully submitted to Fleet Manager');

        // Set the current booking and show pending status
        setCurrentFmBooking(response.booking);
        setFmStatus('pending');
        setSubmittedToFm(true);

        // Add to pending requests list
        setPendingFmRequests(prev => [response.booking, ...prev]);

        // Clear saved state
        clearBookingState();

        // Move to step 5 to show pending status
        setCurrentStep(5);
      } else {
        throw new Error(response.message || 'Failed to submit to Fleet Manager');
      }
    } catch (error) {
      console.error('❌ [Manual Booking] Error submitting to Fleet Manager:', error);
      setFmStatus('none');

      let errorMessage = 'Failed to submit booking';
      if (error.response?.data?.message) {
        errorMessage = error.response.data.message;
      } else if (error.message) {
        errorMessage = error.message;
      }

      alert(`Error: ${errorMessage}`);
    } finally {
      setLoading(false);
    }
  };

  // NEW: Fetch pending FM requests for sidebar
  const fetchPendingFmRequests = async () => {
    try {
      const response = await admin.getPendingFmRequests();
      if (response.success) {
        setPendingFmRequests(response.requests || []);
      }
    } catch (error) {
      console.error('Error fetching pending FM requests:', error);
    }
  };

  // NEW: Cancel pending FM request
  const cancelFmRequest = async (rideId) => {
    try {
      const response = await admin.cancelFmRequest(rideId);
      if (response.success) {
        // Remove from pending list
        setPendingFmRequests(prev => prev.filter(r => r._id !== rideId));

        // If this was the current booking, reset
        if (currentFmBooking?._id === rideId) {
          setCurrentFmBooking(null);
          setFmStatus('cancelled');
        }
      }
    } catch (error) {
      console.error('Error cancelling FM request:', error);
      alert('Failed to cancel request');
    }
  };

  // NEW: Start a new booking (after submitting to FM)
  const startNewBooking = () => {
    resetForm();
    setSubmittedToFm(false);
    setCurrentFmBooking(null);
    setFmStatus('none');
    setCurrentStep(1);
  };

  const resetForm = () => {
    setCurrentStep(1);
    setDropLocation('');
    setDropCoordinates(null);
    setDropLocationConfirmed(false);
    setFareEstimates(null);
    setSelectedVehicle(null);
    setSelectedDriver(null);
    setAvailableDrivers([]);
    setUserPhone('');
    setUserName('');
    setUserEmail('');
    setExistingUser(null);
    setShowRegistrationForm(false);
    setBookingDetails(null);
    clearBookingState();
  };

  // Show loading screen for booking submission
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <FaSpinner className="animate-spin text-4xl text-blue-600 mx-auto mb-4" />
          <p className="text-gray-600">Booking ride...</p>
        </div>
      </div>
    );
  }

  if (bookingDetails) {
    // Show loading states during booking process
    if (bookingDetails.status === 'creating') {
      return (
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto bg-white rounded-lg shadow-lg p-8">
            <div className="text-center mb-6">
              <FaSpinner className="animate-spin text-blue-500 text-6xl mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-gray-800">Creating Ride Booking...</h2>
              <p className="text-gray-600 mt-2">{bookingDetails.message}</p>
            </div>
          </div>
        </div>
      );
    }
    
    // Show waiting for driver acceptance
    if (bookingDetails.status === 'waiting_driver') {
      return (
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto bg-white rounded-lg shadow-lg p-8">
            <div className="text-center mb-6">
              <FaClock className="animate-pulse text-yellow-500 text-6xl mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-gray-800">Waiting for Driver</h2>
              <p className="text-gray-600 mt-2">{bookingDetails.message}</p>
            </div>
            
            <div className="bg-blue-50 p-4 rounded-lg mb-6">
              <h3 className="font-semibold text-lg mb-2">Assigned Driver</h3>
              <div className="flex items-center space-x-4">
                <FaUser className="text-blue-500 text-2xl" />
                <div>
                  <p><strong>Name:</strong> {bookingDetails.selectedDriver?.fullName}</p>
                  <p><strong>Phone:</strong> {bookingDetails.selectedDriver?.mobileNo}</p>
                  <p><strong>Vehicle:</strong> {bookingDetails.selectedDriver?.vehicleNo}</p>
                </div>
              </div>
            </div>
            
            {bookingDetails.queueNumber && (
              <div className="bg-yellow-50 p-4 rounded-lg">
                <h3 className="font-semibold text-lg mb-2">Queue Information</h3>
                <p><strong>Queue Number:</strong> {bookingDetails.queueNumber}</p>
                <p><strong>Booking ID:</strong> {bookingDetails.bookingId}</p>
              </div>
            )}
          </div>
        </div>
      );
    }

    // Show driver offline error state
    if (bookingDetails.status === 'driver_offline') {
      return (
        <div className="container mx-auto px-4 py-8">
          <div className="max-w-2xl mx-auto bg-white rounded-lg shadow-lg p-8">
            <div className="text-center mb-6">
              <FaSpinner className="text-yellow-500 text-6xl mx-auto mb-4" />
              <h2 className="text-2xl font-bold text-gray-800">Driver Not Reachable</h2>
              <p className="text-gray-600 mt-2 whitespace-pre-line">{bookingDetails.message}</p>
            </div>
            
            {bookingDetails.selectedDriver && (
              <div className="bg-yellow-50 border border-yellow-200 p-4 rounded-lg mb-6">
                <h3 className="font-semibold text-lg mb-2">Selected Driver</h3>
                <p><strong>Name:</strong> {bookingDetails.selectedDriver.fullName}</p>
                <p><strong>Phone:</strong> {bookingDetails.selectedDriver.mobileNo}</p>
                <p><strong>Vehicle:</strong> {bookingDetails.selectedDriver.vehicleNo}</p>
                <p className="text-red-600 mt-2">⚠️ Driver appears to be offline or disconnected</p>
              </div>
            )}
            
            <div className="flex gap-4">
              <button
                onClick={() => {
                  setBookingDetails(null);
                  setCurrentStep(5); // Go back to driver selection
                }}
                className="flex-1 bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Select Different Driver
              </button>
              <button
                onClick={() => navigate('/admin/queue-management')}
                className="flex-1 bg-gray-600 text-white py-3 px-6 rounded-lg hover:bg-gray-700 transition-colors"
              >
                Check Queue Management
              </button>
            </div>
          </div>
        </div>
      );
    }
    
    const isWaiting = bookingDetails.status === 'waiting_driver';
    const isRejected = bookingDetails.status === 'driver_rejected';
    
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="max-w-2xl mx-auto bg-white rounded-lg shadow-lg p-8">
          <div className="text-center mb-6">
            {isWaiting ? (
              <>
                <FaSpinner className="text-blue-500 text-6xl mx-auto mb-4 animate-spin" />
                <h2 className="text-2xl font-bold text-gray-800">Waiting for Driver Response...</h2>
                <p className="text-gray-600 mt-2">{bookingDetails.message}</p>
              </>
            ) : isRejected ? (
              <>
                <div className="text-red-500 text-6xl mx-auto mb-4">❌</div>
                <h2 className="text-2xl font-bold text-gray-800">Driver Rejected</h2>
                <p className="text-red-600 mt-2">{bookingDetails.message}</p>
              </>
            ) : (
              <>
                <FaCheckCircle className="text-green-500 text-6xl mx-auto mb-4" />
                <h2 className="text-2xl font-bold text-gray-800">Ride Accepted by Driver!</h2>
              </>
            )}
          </div>

          <div className="space-y-4">
            <div className="bg-gray-50 p-4 rounded-lg">
              <h3 className="font-semibold text-lg mb-2">Ride Details</h3>
              <p><strong>Booking ID:</strong> {bookingDetails.bookingId}</p>
              <p><strong>Queue Number:</strong> {bookingDetails.queueNumber}</p>
              <p><strong>Pickup:</strong> {bookingDetails.pickupLocation?.boothName || currentBooth.name}</p>
              <p><strong>Drop:</strong> {bookingDetails.dropLocation?.address || dropLocation}</p>
              <p><strong>Vehicle Type:</strong> {bookingDetails.vehicleType}</p>
              <p><strong>Fare:</strong> ₹{bookingDetails.estimatedFare}</p>
            </div>

            <div className="bg-blue-50 p-4 rounded-lg">
              <h3 className="font-semibold text-lg mb-2">🔐 OTP Details</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="text-center bg-white p-4 rounded-lg border-2 border-blue-200">
                  <p className="text-sm text-gray-600 mb-2">🚀 Start OTP</p>
                  <p className="text-4xl font-bold text-blue-600 font-mono">{bookingDetails.startOTP}</p>
                  <p className="text-xs text-gray-500 mt-2">Driver needs this to start ride</p>
                </div>
                <div className="text-center bg-white p-4 rounded-lg border-2 border-red-200">
                  <p className="text-sm text-gray-600 mb-2">🏁 End OTP</p>
                  <p className="text-4xl font-bold text-red-600 font-mono">{bookingDetails.endOTP}</p>
                  <p className="text-xs text-gray-500 mt-2">Driver needs this to end ride</p>
                </div>
              </div>
              <div className="mt-4 p-3 bg-yellow-100 rounded-lg">
                <p className="text-sm text-yellow-800">
                  <strong>⚠️ Important:</strong> Share these OTPs with the customer. Driver will ask for them to start and complete the ride.
                </p>
              </div>

              {/* Resend OTP Button */}
              {bookingDetails.user?.phone && (
                <div className="mt-4 text-center">
                  <button
                    onClick={handleResendOTP}
                    disabled={isResendingOTP}
                    className={`px-6 py-2 rounded-lg font-medium transition-all duration-200 ${
                      isResendingOTP
                        ? 'bg-gray-400 cursor-not-allowed'
                        : 'bg-blue-600 hover:bg-blue-700 active:scale-95'
                    } text-white flex items-center gap-2 mx-auto`}
                  >
                    {isResendingOTP ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent"></div>
                        Sending...
                      </>
                    ) : (
                      <>
                        📲 Resend OTP via SMS
                      </>
                    )}
                  </button>
                  <p className="text-xs text-gray-500 mt-2">
                    Send OTPs to customer: {bookingDetails.user?.phone}
                  </p>
                </div>
              )}
            </div>

            {(bookingDetails.driver || bookingDetails.selectedDriver) && (
              <div className="bg-green-50 p-4 rounded-lg border-2 border-green-200">
                <h3 className="font-semibold text-lg mb-3">🚗 Assigned Driver</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="bg-white p-3 rounded-lg">
                    <p className="text-sm text-gray-600">Driver Name</p>
                    <p className="font-bold text-lg">{bookingDetails.driver?.name || bookingDetails.selectedDriver?.fullName}</p>
                  </div>
                  <div className="bg-white p-3 rounded-lg">
                    <p className="text-sm text-gray-600">Phone Number</p>
                    <p className="font-bold text-lg">{bookingDetails.driver?.phone || bookingDetails.selectedDriver?.mobileNo}</p>
                  </div>
                  <div className="bg-white p-3 rounded-lg">
                    <p className="text-sm text-gray-600">Vehicle Number</p>
                    <p className="font-bold text-lg">{bookingDetails.driver?.vehicleNumber || bookingDetails.selectedDriver?.vehicleNo}</p>
                  </div>
                </div>
                <div className="mt-3 p-3 bg-green-100 rounded-lg">
                  <p className="text-sm text-green-800">
                    <strong>✅ Status:</strong> Driver assigned and ready to start ride
                  </p>
                </div>
              </div>
            )}

            <div className="bg-yellow-50 p-4 rounded-lg">
              <h3 className="font-semibold text-lg mb-2">Customer Details</h3>
              <p><strong>Name:</strong> {bookingDetails.userName || userName}</p>
              <p><strong>Phone:</strong> {bookingDetails.userPhone || userPhone}</p>
            </div>
          </div>

          <div className="mt-6 flex gap-4">
            <button
              onClick={resetForm}
              className="flex-1 bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Book Another Ride
            </button>
            <button
              onClick={() => navigate('/admin/rides')}
              className="flex-1 bg-gray-600 text-white py-3 px-6 rounded-lg hover:bg-gray-700 transition-colors"
            >
              View All Rides
            </button>
          </div>
        </div>
      </div>
    );
  }

  // If there's an API key, try LoadScript; otherwise go straight to manual mode
  const renderContent = () => (
    <div className="container mx-auto px-4 py-8">
        {/* Recovery Modal */}
        {showRecoveryModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
              <h3 className="text-lg font-semibold mb-4">Continue Previous Booking?</h3>
              <p className="text-gray-600 mb-6">
                You have an incomplete booking. Would you like to continue where you left off or start fresh?
              </p>
              <div className="flex gap-4">
                <button
                  onClick={restoreBookingState}
                  className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700"
                >
                  Continue Previous
                </button>
                <button
                  onClick={startFreshBooking}
                  className="flex-1 bg-gray-600 text-white py-2 px-4 rounded-lg hover:bg-gray-700"
                >
                  Start Fresh
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Disconnected Driver Warning Modal */}
        {showDisconnectedWarning && disconnectedDriverForWarning && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 max-w-md w-full mx-4">
              <div className="flex items-center text-yellow-600 mb-4">
                <svg className="h-8 w-8 mr-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h3 className="text-xl font-semibold">Driver Not Reachable</h3>
              </div>

              <div className="mb-4">
                <div className="flex items-center mb-3">
                  <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center mr-3">
                    <span className="text-lg font-bold text-gray-600">
                      {disconnectedDriverForWarning.fullName?.charAt(0) || 'D'}
                    </span>
                  </div>
                  <div>
                    <p className="font-semibold text-gray-900">{disconnectedDriverForWarning.fullName}</p>
                    <p className="text-sm text-gray-600">{disconnectedDriverForWarning.mobileNo}</p>
                  </div>
                </div>

                <p className="text-gray-700 mb-2">
                  This driver is currently <span className="font-bold text-yellow-600">not reachable</span>.
                  They may not receive the ride notification immediately.
                </p>

                {disconnectedDriverForWarning.lastActiveTime && (
                  <p className="text-sm text-gray-500">
                    Last seen: {(() => {
                      const lastSeen = new Date(disconnectedDriverForWarning.lastActiveTime);
                      const now = new Date();
                      const diffMinutes = Math.floor((now - lastSeen) / 60000);
                      if (diffMinutes < 1) return 'Just now';
                      if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
                      const diffHours = Math.floor(diffMinutes / 60);
                      return `${diffHours} hour${diffHours > 1 ? 's' : ''} ${diffMinutes % 60} minutes ago`;
                    })()}
                  </p>
                )}
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 mb-4">
                <p className="text-sm text-yellow-800">
                  <strong>Note:</strong> The driver will receive notifications via push notification and polling.
                  If they don't respond within the timeout period, the ride may need to be reassigned.
                </p>
              </div>

              <div className="flex gap-4">
                <button
                  onClick={confirmDisconnectedDriverSelection}
                  className="flex-1 bg-yellow-500 text-white py-2 px-4 rounded-lg hover:bg-yellow-600 font-medium"
                >
                  Assign Anyway
                </button>
                <button
                  onClick={cancelDisconnectedDriverSelection}
                  className="flex-1 bg-gray-300 text-gray-700 py-2 px-4 rounded-lg hover:bg-gray-400 font-medium"
                >
                  Choose Another
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Main Layout: Content + Sidebar */}
        <div className="flex gap-6">
          {/* Main Content Area */}
          <div className="flex-1 max-w-4xl">
        {/* Header with Step Indicator */}
        <div className="bg-white rounded-lg shadow-lg mb-6">
          <div className="px-6 py-4 border-b">
            <div className="flex justify-between items-center">
              <h1 className="text-2xl font-bold text-gray-800">Manual Ride Booking</h1>
              <div className={`px-3 py-1 rounded-full text-sm font-medium ${
                socketConnected 
                  ? 'bg-green-100 text-green-800' 
                  : 'bg-red-100 text-red-800'
              }`}>
                {socketConnected ? '🟢 Connected' : '🔴 Disconnected'}
              </div>
            </div>
            <div className="flex items-center mt-4">
              {[1, 2, 3, 4, 5].map((step) => (
                <React.Fragment key={step}>
                  <div className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-medium ${
                    currentStep === step
                      ? 'bg-blue-600 text-white'
                      : currentStep > step
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-300 text-gray-600'
                  }`}>
                    {currentStep > step ? '✓' : step}
                  </div>
                  {step < 5 && <div className={`h-1 w-8 mx-1 ${currentStep > step ? 'bg-green-600' : 'bg-gray-300'}`} />}
                </React.Fragment>
              ))}
            </div>
            <div className="flex justify-between mt-2 text-xs text-gray-600">
              <span>Location</span>
              <span>Vehicle</span>
              <span>Customer</span>
              <span>Payment</span>
              <span>Confirm</span>
            </div>
          </div>
        </div>

        {/* Main Content */}
        <div className="bg-white rounded-lg shadow-lg p-6">
          {/* Step 1: Location Selection */}
          {currentStep === 1 && (
            <div>
              <h2 className="text-xl font-semibold mb-6">Trip Details</h2>

              {/* Pickup Location (Fixed) */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <FaMapMarkerAlt className="inline mr-2" />
                  Pickup Location (Fixed)
                </label>
                <div className="w-full px-4 py-2 bg-gray-100 border border-gray-300 rounded-lg text-gray-700">
                  {currentBooth.name}
                </div>
              </div>

              {/* Drop Location with Google Maps Autocomplete */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <FaMapMarkerAlt className="inline mr-2" />
                  Drop Location
                </label>

                {mapsError ? (
                  <div>
                    <div className="w-full px-4 py-2 bg-yellow-50 border border-yellow-300 rounded-lg text-yellow-700 mb-3">
                      ⚠️ Google Maps is not available. You can still enter the destination manually.
                    </div>
                    <input
                      type="text"
                      value={dropLocation}
                      onChange={(e) => {
                        setDropLocation(e.target.value);
                        // Set dummy coordinates for manual input
                        if (e.target.value.trim()) {
                          setDropCoordinates({
                            lat: 28.5355, // Default Delhi coordinates
                            lng: 77.2910
                          });
                        } else {
                          setDropCoordinates(null);
                        }
                      }}
                      placeholder="Enter destination address..."
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    <button
                      onClick={() => window.location.reload()}
                      className="mt-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
                    >
                      Retry Google Maps
                    </button>
                  </div>
                ) : !mapsLoaded ? (
                  <div className="w-full px-4 py-2 bg-blue-50 border border-blue-300 rounded-lg text-blue-700">
                    <FaSpinner className="animate-spin inline mr-2" />
                    Loading Google Maps...
                  </div>
                ) : (
                  <Autocomplete
                    onLoad={onAutocompleteLoad}
                    onPlaceChanged={onPlaceChanged}
                    options={{
                      componentRestrictions: { country: "in" },
                      fields: ["geometry", "formatted_address", "name"],
                      types: ["establishment", "geocode"]
                    }}
                  >
                    <input
                      type="text"
                      defaultValue={dropLocation}
                      placeholder="Search for destination..."
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                  </Autocomplete>
                )}

                {isCalculatingFare && (
                  <p className="text-sm text-blue-600 mt-2">
                    <FaSpinner className="animate-spin inline mr-2" />
                    Calculating fare...
                  </p>
                )}
                {fareEstimates && (
                  <p className="text-sm text-green-600 mt-2">
                    ✓ Fare calculated successfully
                  </p>
                )}
              </div>

              {/* Map Toggle Button */}
              <div className="mb-6">
                <button
                  type="button"
                  onClick={() => setShowMap(!showMap)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 border border-gray-300 rounded-lg transition-colors"
                >
                  <FaMapMarkerAlt />
                  {showMap ? 'Hide Map' : 'Show Map for Drop Location'}
                </button>
              </div>

              {/* Map Container */}
              {showMap && mapsLoaded && (
                <div className="mb-6">
                  <div className={`p-3 rounded-lg mb-3 transition-all ${
                    dropCoordinates && !dropLocationConfirmed
                      ? 'bg-green-50 border border-green-200'
                      : 'bg-blue-50'
                  }`}>
                    <p className={`text-sm ${
                      dropCoordinates && !dropLocationConfirmed
                        ? 'text-green-700'
                        : 'text-blue-700'
                    }`}>
                      {dropCoordinates && !dropLocationConfirmed ? (
                        <>
                          <strong>✨ Drop location selected!</strong> Drag the red marker to adjust or click 'Confirm Drop Location' to calculate fare.
                        </>
                      ) : (
                        <>
                          <strong>Tip:</strong> Click anywhere on the map to set drop location, or drag the marker to adjust.
                          Most rides are within 10km radius of the pickup station.
                        </>
                      )}
                    </p>
                  </div>
                  <div style={{ height: '400px', width: '100%', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
                    <GoogleMap
                      mapContainerStyle={{ width: '100%', height: '100%' }}
                      center={dropCoordinates || { lat: currentBooth.lat, lng: currentBooth.lng }}
                      zoom={13}
                      onClick={handleMapClick}
                      onLoad={onMapLoad}
                      options={{
                        zoomControl: true,
                        mapTypeControl: true,
                        scaleControl: true,
                        streetViewControl: false,
                        rotateControl: false,
                        fullscreenControl: true
                      }}
                    >
                      {/* Fixed Pickup Location Marker */}
                      <Marker
                        position={{ lat: currentBooth.lat, lng: currentBooth.lng }}
                        title={currentBooth.name}
                        icon={{
                          url: 'http://maps.google.com/mapfiles/ms/icons/blue-dot.png',
                          scaledSize: new window.google.maps.Size(40, 40)
                        }}
                      />

                      {/* Drop Location Marker (Draggable) */}
                      {dropCoordinates && (
                        <Marker
                          position={dropCoordinates}
                          draggable={true}
                          onDragEnd={handleMarkerDragEnd}
                          title="Drop Location - Drag to adjust"
                          icon={{
                            url: 'http://maps.google.com/mapfiles/ms/icons/red-dot.png',
                            scaledSize: new window.google.maps.Size(40, 40)
                          }}
                          animation={window.google.maps.Animation.DROP}
                        />
                      )}

                      {/* Road route polyline */}
                      {directions && (
                        <DirectionsRenderer
                          directions={directions}
                          options={{
                            suppressMarkers: true,
                            polylineOptions: {
                              strokeColor: '#3B82F6',
                              strokeWeight: 5,
                              strokeOpacity: 0.8,
                            },
                          }}
                        />
                      )}
                    </GoogleMap>
                  </div>

                  {/* Route calculation loading indicator */}
                  {isCalculatingRoute && (
                    <div className="mt-2 flex items-center gap-2 text-sm text-blue-600">
                      <FaSpinner className="animate-spin" />
                      Getting road route...
                    </div>
                  )}

                  {/* Route error (non-blocking — fare still calculated via fallback) */}
                  {routeError && (
                    <div className="mt-2 text-sm text-orange-600 bg-orange-50 border border-orange-200 rounded px-3 py-2">
                      {routeError}
                    </div>
                  )}

                  {/* Map Legend */}
                  <div className="mt-3 flex items-center justify-center gap-6 text-sm text-gray-600">
                    <span className="flex items-center gap-1">
                      <span style={{ color: '#1E40AF' }}>●</span> Pickup Location (Fixed)
                    </span>
                    <span className="flex items-center gap-1">
                      <span style={{ color: '#DC2626' }}>●</span> Drop Location (Draggable)
                    </span>
                    {directions && (
                      <span className="flex items-center gap-1">
                        <span style={{ color: '#3B82F6', fontWeight: 'bold' }}>━━</span> Road Route
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Navigation Buttons */}
              <div className="flex justify-end">
                <button
                  onClick={handleLocationSubmit}
                  disabled={!dropLocation || !dropCoordinates || (dropLocationConfirmed && (isCalculatingRoute || isCalculatingFare))}
                  className="flex items-center bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  {!dropLocation ? 'Enter Drop Location' :
                   !dropCoordinates ? 'Select Drop Location' :
                   !dropLocationConfirmed ? 'Confirm Drop Location' :
                   isCalculatingRoute ? 'Getting Route...' :
                   isCalculatingFare ? 'Calculating Fare...' :
                   'Continue'}
                  <FaArrowRight className="ml-2" />
                </button>
                {mapsError && (
                  <p className="text-sm text-orange-600 mt-2">
                    Google Maps issues detected. You can still proceed if you have entered a location.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Vehicle Selection */}
          {currentStep === 2 && (
            <div>
              <h2 className="text-xl font-semibold mb-6">Choose Vehicle & Fare</h2>

              {/* Trip Summary */}
              <div className="bg-gray-50 p-4 rounded-lg mb-6">
                <h3 className="font-medium mb-2">Trip Summary</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p><strong>From:</strong> {currentBooth.name}</p>
                    <p><strong>To:</strong> {dropLocation}</p>
                  </div>
                  <div>
                    <p><strong>Distance:</strong> {fareEstimates?.distance || 'Calculating...'} km</p>
                  </div>
                </div>
              </div>

              {/* Vehicle Options */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                {getVehicleOptions().map((vehicle) => (
                  <div
                    key={vehicle.type}
                    onClick={() => handleVehicleSelection(vehicle.type)}
                    className={`p-6 rounded-lg border-2 cursor-pointer transition-all ${
                      selectedVehicle?.type === vehicle.type
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-300 hover:border-blue-300'
                    }`}
                  >
                    <div className="text-center">
                      <div className="text-3xl mb-3 text-blue-600">
                        {vehicle.icon}
                      </div>
                      <h3 className="font-medium text-lg">{vehicle.label}</h3>
                      <div className="mt-3">
                        <div className="text-2xl font-bold text-green-600">
                          {typeof vehicle.price === 'number' ? `₹${vehicle.price}` : vehicle.price}
                        </div>
                        <div className="text-sm text-gray-600">
                          {vehicle.eta}
                        </div>
                        {fareEstimates?.estimates?.[vehicle.type] && fareEstimates.detailed && (
                          <div className="text-xs text-gray-500 mt-1 space-y-1 border-t pt-1">
                            <div>Distance: {fareEstimates.distance}km</div>
                            <div className="space-y-0.5">
                              <div>Driver Fare: ₹{fareEstimates.estimates[vehicle.type].driverFare}</div>
                              <div>Platform Spread: ₹{fareEstimates.estimates[vehicle.type].platformEarning}</div>
                              {fareEstimates.estimates[vehicle.type].isNightCharge && (
                                <div>Night +{fareEstimates.estimates[vehicle.type].nightChargeUserPercentage ?? 30}% (User): ₹{fareEstimates.estimates[vehicle.type].nightChargeUserAmount}</div>
                              )}
                              {fareEstimates.estimates[vehicle.type].isNightCharge && (
                                <div>Night +{fareEstimates.estimates[vehicle.type].nightChargeDriverPercentage ?? 25}% (Driver): ₹{fareEstimates.estimates[vehicle.type].nightChargeDriverAmount}</div>
                              )}
                              <div className="font-semibold text-green-700 pt-1">
                                Total: ₹{fareEstimates.estimates[vehicle.type].customerTotalFare}
                              </div>
                            </div>
                          </div>
                        )}
                        {fareEstimates?.estimates?.[vehicle.type] && !fareEstimates.detailed && (
                          <div className="text-xs text-gray-500 mt-1">
                            Distance: {fareEstimates.distance}km
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Navigation Buttons */}
              <div className="flex justify-between">
                <button
                  onClick={prevStep}
                  className="flex items-center px-4 py-2 text-gray-600 hover:text-gray-800"
                >
                  <FaArrowLeft className="mr-2" />
                  Back
                </button>
                {selectedVehicle && (
                  <div className="text-center">
                    <p className="text-sm text-gray-600 mb-2">Selected: {selectedVehicle.label}</p>
                    <button
                      onClick={nextStep}
                      className="flex items-center bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors"
                    >
                      Continue
                      <FaArrowRight className="ml-2" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 3: Customer Verification */}
          {currentStep === 3 && (
            <div className="max-w-2xl mx-auto">
              <h2 className="text-xl font-semibold mb-6 text-center">Customer Information</h2>

              {/* Trip Summary */}
              <div className="bg-gray-50 p-4 rounded-lg mb-6">
                <h3 className="font-medium mb-2">Trip Summary</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p><strong>From:</strong> {currentBooth.name}</p>
                    <p><strong>To:</strong> {dropLocation}</p>
                  </div>
                  <div>
                    <p><strong>Distance:</strong> {fareEstimates?.distance || 'N/A'} km</p>
                    <p><strong>Vehicle:</strong> {selectedVehicle?.label || 'N/A'}</p>
                  </div>
                </div>
              </div>

              {/* Phone Number Input */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  <FaPhone className="inline mr-2" />
                  Customer Phone Number
                </label>
                <input
                  type="tel"
                  value={userPhone}
                  onChange={(e) => {
                    const phone = e.target.value;
                    setUserPhone(phone);
                    if (phone.length === 10) {
                      handlePhoneLookup(phone);
                    } else {
                      setShowRegistrationForm(false);
                      setExistingUser(null);
                    }
                  }}
                  placeholder="Enter 10-digit phone number"
                  maxLength="10"
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-lg"
                  disabled={isLookingUpCustomer || isRegisteringCustomer}
                />
                {isLookingUpCustomer && (
                  <p className="text-sm text-blue-600 mt-2">
                    <FaSpinner className="inline animate-spin mr-2" />
                    Looking up customer...
                  </p>
                )}
              </div>

              {/* Existing Customer Found */}
              {existingUser && (
                <div className="bg-green-50 border-2 border-green-500 rounded-lg p-6 mb-6">
                  <div className="flex items-center mb-4">
                    <FaCheckCircle className="text-green-600 text-2xl mr-3" />
                    <h3 className="text-lg font-semibold text-green-800">Customer Found</h3>
                  </div>
                  <div className="space-y-2 mb-4">
                    <p className="text-gray-700"><strong>Name:</strong> {existingUser.name}</p>
                    <p className="text-gray-700"><strong>Phone:</strong> {existingUser.phone}</p>
                    {existingUser.email && (
                      <p className="text-gray-700"><strong>Email:</strong> {existingUser.email}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Registration Form for New Customer */}
              {showRegistrationForm && !existingUser && userPhone.length === 10 && (
                <div className="bg-blue-50 border-2 border-blue-500 rounded-lg p-6 mb-6">
                  <div className="flex items-center mb-4">
                    <FaUserPlus className="text-blue-600 text-2xl mr-3" />
                    <h3 className="text-lg font-semibold text-blue-800">New Customer Registration</h3>
                  </div>
                  <p className="text-sm text-gray-600 mb-4">
                    Customer not found. Please fill in their details to register:
                  </p>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Customer Name *
                      </label>
                      <input
                        type="text"
                        value={userName}
                        onChange={(e) => setUserName(e.target.value)}
                        placeholder="Enter customer name"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        disabled={isRegisteringCustomer}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Email (Optional)
                      </label>
                      <input
                        type="email"
                        value={userEmail}
                        onChange={(e) => setUserEmail(e.target.value)}
                        placeholder="Enter email address"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        disabled={isRegisteringCustomer}
                      />
                    </div>

                    <button
                      onClick={handleRegisterCustomer}
                      disabled={!userName || isRegisteringCustomer}
                      className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium disabled:bg-gray-400 disabled:cursor-not-allowed"
                    >
                      {isRegisteringCustomer ? (
                        <>
                          <FaSpinner className="inline animate-spin mr-2" />
                          Registering Customer...
                        </>
                      ) : (
                        <>
                          <FaUserPlus className="inline mr-2" />
                          Register Customer
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {/* Help Text */}
              {!showRegistrationForm && !existingUser && userPhone.length < 10 && (
                <div className="text-center text-gray-500 text-sm">
                  Enter a 10-digit phone number to lookup or register a customer
                </div>
              )}

              {/* Navigation Buttons */}
              <div className="flex justify-between mt-6">
                <button
                  onClick={prevStep}
                  className="flex items-center px-4 py-2 text-gray-600 hover:text-gray-800"
                >
                  <FaArrowLeft className="mr-2" />
                  Back
                </button>
                {existingUser && (
                  <button
                    onClick={handleProceedFromCustomer}
                    className="flex items-center bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 transition-colors font-medium"
                  >
                    Continue
                    <FaArrowRight className="ml-2" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Payment Collection */}
          {currentStep === 4 && (
            <div className="max-w-2xl mx-auto">
              <h2 className="text-xl font-semibold mb-6 text-center">💳 Collect Payment from Customer</h2>

              {/* Trip Summary */}
              <div className="bg-gray-50 p-4 rounded-lg mb-6">
                <h3 className="font-medium mb-2">Trip Summary</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p><strong>From:</strong> {currentBooth.name}</p>
                    <p><strong>To:</strong> {dropLocation}</p>
                    <p><strong>Vehicle:</strong> {selectedVehicle?.label || 'N/A'}</p>
                  </div>
                  <div>
                    <p><strong>Distance:</strong> {fareEstimates?.distance || 'N/A'} km</p>
                    <p><strong>Customer:</strong> {userName}</p>
                    <p><strong>Phone:</strong> {userPhone}</p>
                  </div>
                </div>
              </div>

              {/* Total Amount - Large Display */}
              <div className="bg-green-50 border-2 border-green-500 rounded-lg p-6 mb-6 text-center">
                <p className="text-sm text-gray-600 mb-2">Total Amount to Collect</p>
                <p className="text-5xl font-bold text-green-600">
                  ₹{selectedVehicle?.price}
                </p>
                {fareEstimates?.estimates?.[selectedVehicle?.type] && fareEstimates.detailed && (
                  <div className="mt-4 text-xs text-gray-600 space-y-1">
                    <p>Driver Fare: ₹{fareEstimates.estimates[selectedVehicle.type].driverFare}</p>
                    <p>Platform Spread: ₹{fareEstimates.estimates[selectedVehicle.type].platformEarning}</p>
                    {fareEstimates.estimates[selectedVehicle.type].isNightCharge && (
                      <p>Night Charge User (+{fareEstimates.estimates[selectedVehicle.type].nightChargeUserPercentage ?? 30}%): ₹{fareEstimates.estimates[selectedVehicle.type].nightChargeUserAmount}</p>
                    )}
                    {fareEstimates.estimates[selectedVehicle.type].isNightCharge && (
                      <p>Night Charge Driver (+{fareEstimates.estimates[selectedVehicle.type].nightChargeDriverPercentage ?? 25}%): ₹{fareEstimates.estimates[selectedVehicle.type].nightChargeDriverAmount}</p>
                    )}
                  </div>
                )}
              </div>

              {/* Payment Mode Selection */}
              <div className="bg-white border-2 border-blue-300 rounded-lg p-6 mb-6">
                <h3 className="text-center text-gray-700 font-medium mb-4">
                  Select Payment Mode
                </h3>

                <div className="flex gap-4 justify-center">
                  <button
                    type="button"
                    onClick={() => setPaymentMode('cash')}
                    className={`flex-1 p-4 rounded-lg border-2 transition-all ${
                      paymentMode === 'cash'
                        ? 'border-green-500 bg-green-50 shadow-md'
                        : 'border-gray-300 bg-white hover:border-gray-400'
                    }`}
                  >
                    <div className="text-center">
                      <div className="text-3xl mb-2">💵</div>
                      <div className="font-semibold">Cash</div>
                      <div className="text-xs text-gray-500 mt-1">Collect payment in cash</div>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setPaymentMode('online')}
                    className={`flex-1 p-4 rounded-lg border-2 transition-all ${
                      paymentMode === 'online'
                        ? 'border-blue-500 bg-blue-50 shadow-md'
                        : 'border-gray-300 bg-white hover:border-gray-400'
                    }`}
                  >
                    <div className="text-center">
                      <div className="text-3xl mb-2">📱</div>
                      <div className="font-semibold">Online Payment (UPI)</div>
                      <div className="text-xs text-gray-500 mt-1">Customer scans QR code</div>
                    </div>
                  </button>
                </div>
              </div>

              {/* Cash Payment Note */}
              {paymentMode === 'cash' && (
                <div className="bg-yellow-50 border border-yellow-300 rounded-lg p-4 mb-6">
                  <p className="text-center text-yellow-800 font-medium">
                    💵 Collect ₹{selectedVehicle?.price} in cash from the customer
                  </p>
                </div>
              )}

              {/* UPI QR Code - Show only for Online Payment */}
              {paymentMode === 'online' && (
                <div className="bg-white border-2 border-gray-300 rounded-lg p-6 mb-6">
                <p className="text-center text-gray-700 font-medium mb-4">
                  Scan QR Code to Pay
                </p>
                <div className="flex justify-center mb-4">
                  <img
                    src="/siddharth-upi-qr.jpeg"
                    alt="UPI QR Code"
                    className="w-70 h-auto rounded-lg"
                    style={{ maxWidth: '280px' }}
                  />
                </div>
                <div className="flex justify-center mb-4">
                  <button
                    onClick={() => window.open('/siddharth-upi-qr.jpeg', '_blank')}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Open QR Code in New Tab
                  </button>
                </div>
                <p className="text-center text-sm text-gray-500">
                  Works with GPay, PhonePe, Paytm, BharatPe & all UPI apps
                </p>
                <p className="text-center text-xs text-gray-400 mt-2">
                  UPI ID: siddharth.maheshwari@okhdfcbank
                </p>
              </div>
              )}

              {/* Navigation */}
              <div className="flex justify-between mt-6">
                <button
                  onClick={prevStep}
                  className="flex items-center px-4 py-2 text-gray-600 hover:text-gray-800"
                >
                  <FaArrowLeft className="mr-2" />
                  Back
                </button>
                <button
                  onClick={handlePaymentCollected}
                  className="flex items-center bg-green-600 text-white px-6 py-3 rounded-lg hover:bg-green-700 transition-colors font-medium"
                >
                  ✓ Payment Collected - Continue
                  <FaArrowRight className="ml-2" />
                </button>
              </div>
            </div>
          )}

          {/* Step 5: Fleet Manager Pending Status / Driver Selection */}
          {currentStep === 5 && (
            <div>
              {/* NEW: Fleet Manager Pending Status Screen */}
              {submittedToFm && (
                <div className="max-w-2xl mx-auto">
                  {/* Header */}
                  <div className="text-center mb-6">
                    <h2 className="text-2xl font-bold text-gray-800">
                      {fmStatus === 'pending' && '⏳ Waiting for Fleet Manager'}
                      {fmStatus === 'assigned' && '✅ Driver Assigned!'}
                      {fmStatus === 'cancelled' && '❌ Booking Cancelled'}
                    </h2>
                    <p className="text-gray-600 mt-2">
                      {fmStatus === 'pending' && 'Your booking has been sent to Fleet Manager for driver assignment'}
                      {fmStatus === 'assigned' && 'A driver has accepted your booking'}
                      {fmStatus === 'cancelled' && 'This booking was cancelled'}
                    </p>
                  </div>

                  {/* Booking Details Card */}
                  <div className="bg-white rounded-lg shadow-md p-6 mb-6">
                    <h3 className="font-semibold text-lg mb-4 border-b pb-2">Booking Details</h3>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-gray-500">Booking ID</p>
                        <p className="font-medium">{currentFmBooking?.bookingId || 'N/A'}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Vehicle</p>
                        <p className="font-medium">{selectedVehicle?.label || currentFmBooking?.vehicleType}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Customer</p>
                        <p className="font-medium">{userName || currentFmBooking?.userName}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Phone</p>
                        <p className="font-medium">{userPhone || currentFmBooking?.userPhone}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">From</p>
                        <p className="font-medium">{currentBooth?.name}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">To</p>
                        <p className="font-medium truncate">{dropLocation || currentFmBooking?.dropLocation?.address}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Fare</p>
                        <p className="font-medium text-green-600">₹{selectedVehicle?.price || currentFmBooking?.estimatedFare}</p>
                      </div>
                      <div>
                        <p className="text-gray-500">Payment</p>
                        <p className="font-medium">{paymentMode === 'cash' ? '💵 Cash' : '📱 UPI'} (Collected)</p>
                      </div>
                    </div>
                  </div>

                  {/* Pending Status */}
                  {fmStatus === 'pending' && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 mb-6 text-center">
                      <FaClock className="animate-pulse text-yellow-500 text-5xl mx-auto mb-4" />
                      <h3 className="text-lg font-semibold text-yellow-700 mb-2">Waiting for Driver Assignment</h3>
                      <p className="text-yellow-600 text-sm">
                        Fleet Manager will assign a driver shortly. You'll be notified when a driver accepts.
                      </p>
                      <div className="mt-4 flex justify-center">
                        <div className="animate-pulse flex space-x-2">
                          <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
                          <div className="w-2 h-2 bg-yellow-500 rounded-full animation-delay-200"></div>
                          <div className="w-2 h-2 bg-yellow-500 rounded-full animation-delay-400"></div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Driver Assigned - Show OTPs */}
                  {fmStatus === 'assigned' && currentFmBooking && (
                    <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-6">
                      <div className="text-center mb-4">
                        <FaCheckCircle className="text-green-500 text-5xl mx-auto mb-3" />
                        <h3 className="text-xl font-bold text-green-700">Driver Assigned!</h3>
                      </div>

                      {/* Driver Info */}
                      <div className="bg-white rounded-lg p-4 mb-4 border border-green-200">
                        <div className="flex items-center gap-4">
                          <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
                            <FaUser className="text-green-600 text-xl" />
                          </div>
                          <div>
                            <p className="font-semibold text-gray-900">{currentFmBooking.driverName || 'Driver'}</p>
                            <p className="text-sm text-gray-600">{currentFmBooking.driverPhone}</p>
                            {currentFmBooking.vehicleNumber && (
                              <p className="text-xs text-gray-500">Vehicle: {currentFmBooking.vehicleNumber}</p>
                            )}
                          </div>
                          {currentFmBooking.queueNumber && (
                            <div className="ml-auto text-right">
                              <p className="text-xs text-gray-500">Queue</p>
                              <p className="font-bold text-lg">#{currentFmBooking.queueNumber}</p>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* OTP Display - Prominent */}
                      <div className="bg-white rounded-lg p-4 mb-4">
                        <h4 className="font-semibold text-center mb-3 text-gray-700">🔐 OTP Codes for Customer</h4>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="text-center bg-green-50 p-4 rounded-lg border-2 border-green-300">
                            <p className="text-xs text-gray-600 mb-1">Start OTP</p>
                            <p className="text-4xl font-bold text-green-600 font-mono tracking-wider">
                              {currentFmBooking.startOTP || '----'}
                            </p>
                          </div>
                          <div className="text-center bg-red-50 p-4 rounded-lg border-2 border-red-300">
                            <p className="text-xs text-gray-600 mb-1">End OTP</p>
                            <p className="text-4xl font-bold text-red-600 font-mono tracking-wider">
                              {currentFmBooking.endOTP || '----'}
                            </p>
                          </div>
                        </div>
                        <p className="text-xs text-center text-gray-500 mt-3">
                          Share these OTPs with the customer for ride verification
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Cancelled Status */}
                  {fmStatus === 'cancelled' && (
                    <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-6 text-center">
                      <FaTimes className="text-red-500 text-5xl mx-auto mb-4" />
                      <h3 className="text-lg font-semibold text-red-700 mb-2">Booking Cancelled</h3>
                      {currentFmBooking?.cancellationReason && (
                        <p className="text-red-600 text-sm">Reason: {currentFmBooking.cancellationReason}</p>
                      )}
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-4">
                    <button
                      onClick={startNewBooking}
                      className="flex-1 bg-blue-600 text-white py-3 px-6 rounded-lg hover:bg-blue-700 transition-colors font-medium flex items-center justify-center gap-2"
                    >
                      <FaArrowRight />
                      Book Another Ride
                    </button>

                    {fmStatus === 'pending' && currentFmBooking && (
                      <button
                        onClick={() => cancelFmRequest(currentFmBooking._id)}
                        className="px-6 py-3 border-2 border-red-300 text-red-600 rounded-lg hover:bg-red-50 transition-colors font-medium"
                      >
                        Cancel Request
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* OLD: Driver Selection UI - Only show if NOT submitted to FM */}
              {!submittedToFm && (
              <>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-xl font-semibold">Queue Management & Driver Selection</h2>
                <button
                  onClick={handleRefreshDrivers}
                  className="flex items-center px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  <FaSpinner className={loadingDrivers ? 'animate-spin mr-2' : 'mr-2'} />
                  Refresh
                </button>
              </div>

              {/* Success/Error Messages */}
              {queueSuccess && (
                <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg mb-4">
                  ✓ {queueSuccess}
                </div>
              )}
              {queueError && (
                <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg mb-4">
                  ✗ {queueError}
                </div>
              )}

              {/* Tabs: Queue | Requests (matching QueueManagement) */}
              <div className="flex border-b border-gray-200 mb-4">
                <button
                  onClick={() => setActiveDriverTab('queue')}
                  className={`px-4 py-2 font-medium transition-colors ${
                    activeDriverTab === 'queue'
                      ? 'text-blue-600 border-b-2 border-blue-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <FaUsers className="inline mr-2" />
                  Queue ({availableDrivers.length})
                </button>
                <button
                  onClick={() => setActiveDriverTab('requests')}
                  className={`px-4 py-2 font-medium transition-colors relative ${
                    activeDriverTab === 'requests'
                      ? 'text-blue-600 border-b-2 border-blue-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <FaClock className="inline mr-2" />
                  Pending Requests
                  {(pendingRequestsCount + pendingOfflineRequestsCount) > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
                      {pendingRequestsCount + pendingOfflineRequestsCount}
                    </span>
                  )}
                </button>
              </div>

              {/* Trip Summary */}
              <div className="bg-gray-50 p-4 rounded-lg mb-6">
                <h3 className="font-medium mb-2">Trip Summary</h3>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <p><strong>Vehicle:</strong> {selectedVehicle?.label}</p>
                    <p><strong>Customer Fare:</strong> ₹{selectedVehicle?.price}</p>
                    {fareEstimates?.detailed && fareEstimates?.estimates?.[selectedVehicle?.type] && (
                      <div className="text-xs mt-1 space-y-0.5">
                        <p>Driver: ₹{fareEstimates.estimates[selectedVehicle.type].driverFare}</p>
                        <p>Platform: ₹{fareEstimates.estimates[selectedVehicle.type].platformEarning}</p>
                        {fareEstimates.estimates[selectedVehicle.type].isNightCharge && (
                          <p>Night (User +{fareEstimates.estimates[selectedVehicle.type].nightChargeUserPercentage ?? 30}%): ₹{fareEstimates.estimates[selectedVehicle.type].nightChargeUserAmount}</p>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <p><strong>From:</strong> {currentBooth.name}</p>
                    <p><strong>To:</strong> {dropLocation}</p>
                  </div>
                  <div>
                    <p><strong>Customer:</strong> {userName}</p>
                    <p><strong>Phone:</strong> {userPhone}</p>
                  </div>
                </div>
              </div>

              {/* NEW: Request Status Card */}
              {requestStatus === 'none' && (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-6 text-center mb-6">
                  <FaPaperPlane className="text-gray-400 text-4xl mx-auto mb-3" />
                  <h3 className="text-lg font-medium text-gray-700 mb-2">Ready to Send Request</h3>
                  <p className="text-gray-500 text-sm">Click "Send Request" on a driver below to send them the ride request</p>
                </div>
              )}

              {requestStatus === 'sending' && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center mb-6">
                  <FaSpinner className="animate-spin text-blue-500 text-4xl mx-auto mb-3" />
                  <h3 className="text-lg font-medium text-blue-700">Creating Booking...</h3>
                  <p className="text-blue-600 text-sm">Please wait</p>
                </div>
              )}

              {requestStatus === 'waiting' && activeRequest && (
                <div className="bg-yellow-50 border border-yellow-300 rounded-xl p-6 mb-6 shadow-sm">
                  <div className="text-center mb-4">
                    <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-3">
                      <FaClock className="animate-pulse text-yellow-600 text-3xl" />
                    </div>
                    <h3 className="text-xl font-bold text-yellow-700">⏳ Waiting for Driver Response</h3>
                    <p className="text-yellow-600 mt-1">Request sent to <strong>{activeRequest?.driverName}</strong></p>
                  </div>

                  {/* Warning if driver was not notified */}
                  {activeRequest?.driverNotified === false && (
                    <div className="bg-orange-100 border border-orange-300 rounded-lg p-3 mb-4">
                      <p className="text-orange-700 text-sm text-center">
                        <strong>⚠️ Driver appears disconnected</strong><br />
                        Request created but driver may not see it until they reconnect
                      </p>
                    </div>
                  )}

                  <div className="bg-white rounded-lg p-4 mb-4 border border-yellow-200">
                    <div className="flex justify-between items-center mb-2">
                      <span className="text-gray-600 font-medium">Time Remaining:</span>
                      <span className={`font-bold text-3xl ${requestTimer <= 10 ? 'text-red-600 animate-pulse' : 'text-yellow-600'}`}>
                        {requestTimer}s
                      </span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-3">
                      <div
                        className={`h-3 rounded-full transition-all ${requestTimer <= 10 ? 'bg-red-500' : 'bg-yellow-500'}`}
                        style={{ width: `${(requestTimer / 60) * 100}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-500 mt-2 text-center">
                      Driver must accept within 1 minute
                    </p>
                  </div>

                  <div className="bg-white rounded-lg p-3 mb-4 border border-gray-200">
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <p className="text-gray-600"><strong>Driver:</strong> {activeRequest?.driverName}</p>
                      <p className="text-gray-600"><strong>Phone:</strong> {activeRequest?.driverPhone}</p>
                      <p className="text-gray-600 col-span-2"><strong>Booking ID:</strong> {activeRequest?.bookingId}</p>
                    </div>
                  </div>

                  <button
                    onClick={handleCancelPendingRequest}
                    className="w-full bg-red-100 text-red-700 py-3 px-4 rounded-lg hover:bg-red-200 transition-colors font-semibold border border-red-200"
                  >
                    <FaTimes className="inline mr-2" />
                    Cancel Request & Try Another Driver
                  </button>
                </div>
              )}

              {requestStatus === 'accepted' && activeRequest && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-6 mb-6">
                  <div className="text-center mb-4">
                    <FaCheckCircle className="text-green-500 text-5xl mx-auto mb-3" />
                    <h3 className="text-xl font-bold text-green-700">Ride Accepted!</h3>
                    <p className="text-green-600">Driver has accepted the ride</p>
                  </div>

                  {/* OTP Display */}
                  <div className="bg-white rounded-lg p-4 mb-4">
                    <h4 className="font-semibold text-center mb-3">OTP Codes</h4>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center bg-blue-50 p-3 rounded-lg border-2 border-blue-200">
                        <p className="text-xs text-gray-600 mb-1">Start OTP</p>
                        <p className="text-3xl font-bold text-blue-600 font-mono">
                          {activeRequest?.startOTP}
                        </p>
                      </div>
                      <div className="text-center bg-red-50 p-3 rounded-lg border-2 border-red-200">
                        <p className="text-xs text-gray-600 mb-1">End OTP</p>
                        <p className="text-3xl font-bold text-red-600 font-mono">
                          {activeRequest?.endOTP}
                        </p>
                      </div>
                    </div>
                    <p className="text-xs text-center text-gray-500 mt-2">
                      Share these OTPs with the customer
                    </p>
                  </div>

                  <div className="bg-green-100 rounded-lg p-4 mb-4 text-sm">
                    <p><strong>Driver:</strong> {activeRequest?.driverName}</p>
                    <p><strong>Booking ID:</strong> {activeRequest?.bookingId}</p>
                    <p><strong>Queue #:</strong> {activeRequest?.queueNumber}</p>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => {
                        resetRequestState();
                        setCurrentStep(1);
                        // Reset form for new booking
                        setDropLocation('');
                        setDropCoordinates(null);
                        setFareEstimates(null);
                        setSelectedVehicle(null);
                        setUserPhone('');
                        setUserName('');
                        setExistingUser(null);
                      }}
                      className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium"
                    >
                      Book Another
                    </button>
                    <button
                      onClick={() => navigate('/admin/rides')}
                      className="flex-1 bg-gray-600 text-white py-2 px-4 rounded-lg hover:bg-gray-700 transition-colors font-medium"
                    >
                      View Rides
                    </button>
                  </div>
                </div>
              )}

              {requestStatus === 'rejected' && activeRequest && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-6">
                  <div className="text-center mb-4">
                    <FaTimes className="text-red-500 text-4xl mx-auto mb-3" />
                    <h3 className="text-lg font-medium text-red-700">Request Rejected</h3>
                    <p className="text-red-600 text-sm">{activeRequest?.rejectionReason || 'Driver did not accept'}</p>
                  </div>

                  <div className="text-sm text-gray-600 mb-4">
                    <p><strong>Driver:</strong> {activeRequest?.driverName}</p>
                  </div>

                  <button
                    onClick={resetRequestState}
                    className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium"
                  >
                    Send to Another Driver
                  </button>
                </div>
              )}

              {requestStatus === 'expired' && activeRequest && (
                <div className="bg-red-50 border border-red-300 rounded-xl p-6 mb-6 shadow-sm">
                  <div className="text-center mb-4">
                    <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
                      <FaExclamationTriangle className="text-red-500 text-3xl" />
                    </div>
                    <h3 className="text-xl font-bold text-red-700">⏱️ Request Expired</h3>
                    <p className="text-red-600 mt-2">{activeRequest?.expiredReason || 'Driver did not respond within 1 minute'}</p>
                  </div>

                  <div className="bg-white rounded-lg p-3 mb-4 border border-red-100">
                    <p className="text-sm text-gray-600">
                      <strong>Driver:</strong> {activeRequest?.driverName || 'Unknown'}
                    </p>
                    <p className="text-sm text-gray-500 mt-1">
                      The request was not accepted in time. You can try sending to another driver.
                    </p>
                  </div>

                  <button
                    onClick={resetRequestState}
                    className="w-full bg-blue-600 text-white py-3 px-4 rounded-lg hover:bg-blue-700 transition-colors font-semibold text-lg"
                  >
                    🔄 Try Another Driver
                  </button>
                </div>
              )}

              {requestStatus === 'failed' && activeRequest && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-6 mb-6">
                  <div className="text-center mb-4">
                    <FaExclamationTriangle className="text-red-500 text-4xl mx-auto mb-3" />
                    <h3 className="text-lg font-medium text-red-700">Request Failed</h3>
                    <p className="text-red-600 text-sm">{activeRequest?.errorMessage || 'Failed to create booking'}</p>
                  </div>

                  <button
                    onClick={resetRequestState}
                    className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors font-medium"
                  >
                    Try Again
                  </button>
                </div>
              )}

              {/* Hide driver list when request is accepted - only show OTPs */}
              {requestStatus !== 'accepted' && (
              <>
              {/* Queue Tab - Driver Selection */}
              {activeDriverTab === 'queue' && (
              <div className="mb-6">
                <h3 className="font-medium mb-4 flex items-center">
                  <FaUsers className="mr-2 text-blue-600" />
                  Available {selectedVehicle?.label} Drivers ({availableDrivers.length})
                </h3>

                {/* Auto Assign Option */}
                <div className="mb-4">
                  {(() => {
                    const firstConnectedDriver = availableDrivers.find(d =>
                      d.connectionStatus === 'connected' || (d.isOnline && !d.connectionStatus)
                    );
                    const hasConnectedDrivers = !!firstConnectedDriver;

                    return (
                      <button
                        onClick={handleAutoAssignment}
                        disabled={!hasConnectedDrivers}
                        className={`w-full p-4 border-2 border-dashed rounded-lg transition-colors font-medium ${
                          hasConnectedDrivers
                            ? 'border-blue-300 hover:border-blue-500 hover:bg-blue-50 text-blue-600'
                            : 'border-gray-300 bg-gray-50 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        🚀 Auto Assign (First Connected Driver)
                        {hasConnectedDrivers ? (
                          <div className="text-sm text-gray-600 mt-1">
                            Next: {firstConnectedDriver.fullName} (Queue #{firstConnectedDriver.queuePosition})
                          </div>
                        ) : (
                          <div className="text-sm text-gray-500 mt-1">
                            No connected drivers available - select manually
                          </div>
                        )}
                      </button>
                    );
                  })()}
                </div>

                {/* Connection Status Summary Banner */}
                {!loadingDrivers && availableDrivers.length > 0 && (
                  <div className="mb-4 flex flex-wrap gap-2">
                    <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                      ✓ {availableDrivers.filter(d => d.connectionStatus === 'connected' || (d.isOnline && !d.connectionStatus)).length} Connected
                    </span>
                    <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full text-sm font-medium">
                      ⚠ {availableDrivers.filter(d => d.connectionStatus === 'disconnected' || (!d.isOnline && d.inQueue)).length} Not Reachable
                    </span>
                  </div>
                )}

                {/* Warning: No Connected Drivers */}
                {!loadingDrivers && availableDrivers.length > 0 &&
                  availableDrivers.filter(d => d.connectionStatus === 'connected' || (d.isOnline && !d.connectionStatus)).length === 0 && (
                  <div className="bg-red-50 border border-red-200 p-4 rounded-lg mb-4">
                    <p className="text-red-800 font-medium">
                      ⚠️ No connected drivers available!
                    </p>
                    <p className="text-red-600 text-sm mt-1">
                      All drivers in queue are "Not Reachable". You can still select one, but they may not receive the booking immediately.
                    </p>
                  </div>
                )}

                {/* Loading State */}
                {loadingDrivers && (
                  <div className="text-center py-8">
                    <FaSpinner className="animate-spin text-blue-600 text-2xl mx-auto mb-4" />
                    <p className="text-gray-600">Loading available drivers...</p>
                  </div>
                )}

                {/* Error State */}
                {driverError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-4">
                    <p className="text-red-800 text-sm">{driverError}</p>
                  </div>
                )}

                {/* Driver List */}
                {!loadingDrivers && (
                  <div className="space-y-3 max-h-96 overflow-y-auto">
                    {availableDrivers.length === 0 ? (
                      <div className="text-center py-8 bg-gray-50 rounded-lg">
                        <FaUser className="text-gray-400 text-3xl mx-auto mb-4" />
                        <p className="text-gray-600 font-medium">No {selectedVehicle?.label} drivers available</p>
                        <p className="text-gray-500 text-sm">Please check queue management or try a different vehicle type</p>
                      </div>
                    ) : (
                      availableDrivers.map((driver, index) => {
                        const isActiveDriver = activeRequest?.driverId === driver._id;
                        const isDisconnected = driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue);

                        return (
                        <div
                          key={driver._id}
                          className={`p-4 border-2 rounded-lg transition-all ${
                            isActiveDriver
                              ? 'border-yellow-400 bg-yellow-50'
                              : driver.isVehicleTypeMismatch
                                ? 'border-orange-200 bg-orange-50'
                                : isDisconnected
                                  ? 'border-yellow-200 bg-yellow-50/50'
                                  : index === 0
                                    ? 'border-green-200 bg-green-50'
                                    : 'border-gray-200 bg-gray-50'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-4">
                              {/* Queue Position */}
                              <div className={`flex items-center justify-center w-10 h-10 rounded-full text-sm font-bold ${
                                index === 0 
                                  ? 'bg-green-600 text-white' 
                                  : 'bg-blue-100 text-blue-800'
                              }`}>
                                #{driver.queuePosition || index + 1}
                              </div>
                              
                              {/* Driver Photo */}
                              {driver.driverSelfie ? (
                                <img 
                                  src={getImageUrl(driver.driverSelfie)} 
                                  alt={driver.fullName} 
                                  className="w-12 h-12 rounded-full object-cover border-2 border-gray-200"
                                />
                              ) : (
                                <div className="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center">
                                  <FaUser className="text-gray-400" />
                                </div>
                              )}
                              
                              {/* Driver Info */}
                              <div>
                                <h4 className="font-medium text-gray-800 flex items-center flex-wrap gap-2">
                                  {driver.fullName}

                                  {/* Connection Status Badge - NEW */}
                                  {driver.connectionStatus === 'connected' || (driver.isOnline && !driver.connectionStatus) ? (
                                    <span className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded-full flex items-center">
                                      🟢 Online
                                    </span>
                                  ) : driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue) ? (
                                    <span className="px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded-full flex items-center">
                                      ⚠️ Not Reachable
                                    </span>
                                  ) : (
                                    <span className="px-2 py-1 text-xs bg-gray-100 text-gray-800 rounded-full flex items-center">
                                      ⚫ Offline
                                    </span>
                                  )}

                                  {index === 0 && !driver.isVehicleTypeMismatch && (
                                    <span className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full">
                                      Next in Queue
                                    </span>
                                  )}
                                  {driver.isVehicleTypeMismatch && (
                                    <span className="px-2 py-1 text-xs bg-orange-100 text-orange-800 rounded-full">
                                      Different Vehicle
                                    </span>
                                  )}
                                </h4>
                                <p className="text-sm text-gray-600 flex items-center">
                                  <FaPhone className="mr-1" /> {driver.mobileNo}
                                </p>

                                {/* Last Seen Time for Not Reachable Drivers - NEW */}
                                {(driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue)) && driver.lastActiveTime && (
                                  <p className="text-xs text-yellow-700 mt-1">
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

                                <p className={`text-sm ${driver.isVehicleTypeMismatch ? 'text-orange-600' : 'text-gray-500'}`}>
                                  🚗 {driver.vehicleNo} • {driver.vehicleType?.toUpperCase()}
                                  {driver.isVehicleTypeMismatch && (
                                    <span className="ml-2 text-xs">
                                      (Expected: {selectedVehicle?.type?.toUpperCase()})
                                    </span>
                                  )}
                                </p>
                              </div>
                            </div>
                            
                            {/* Driver Stats & Actions */}
                            <div className="text-right flex flex-col items-end gap-2">
                              <div>
                                <div className="text-sm text-blue-600 font-medium">
                                  <FaClock className="inline mr-1" />
                                  {driver.queueEntryTime ? (
                                    (() => {
                                      const waitTime = Math.floor((new Date() - new Date(driver.queueEntryTime)) / 60000);
                                      return waitTime < 60 ? `${waitTime}m in queue` : `${Math.floor(waitTime/60)}h ${waitTime%60}m in queue`;
                                    })()
                                  ) : 'Just joined'}
                                </div>
                                {driver.rating && (
                                  <div className="text-xs text-yellow-600">
                                    ⭐ {driver.rating.toFixed(1)} ({driver.totalRides || 0} rides)
                                  </div>
                                )}
                                {driver.currentMetroBooth && (
                                  <div className="text-xs text-gray-500">
                                    📍 {driver.currentMetroBooth}
                                  </div>
                                )}
                              </div>
                              {/* Action Buttons */}
                              <div className="flex gap-2">
                                {/* Remove from Queue Button */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveFromQueue(driver._id, driver.fullName);
                                  }}
                                  className="px-2 py-1 text-xs bg-red-100 text-red-700 hover:bg-red-200 rounded-lg transition-colors"
                                  title="Remove from queue"
                                >
                                  🗑️
                                </button>

                                {/* Send Request Button - NEW */}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleSendRequest(driver);
                                  }}
                                  disabled={requestStatus === 'sending' || requestStatus === 'waiting' || requestStatus === 'accepted' || (isActiveDriver && requestStatus === 'waiting')}
                                  className={`flex items-center px-3 py-1 rounded-lg text-sm font-medium transition-all ${
                                    isActiveDriver && requestStatus === 'waiting'
                                      ? 'bg-yellow-200 text-yellow-800 cursor-not-allowed'
                                      : requestStatus === 'sending' || requestStatus === 'waiting' || requestStatus === 'accepted'
                                        ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                                        : isDisconnected
                                          ? 'bg-yellow-500 hover:bg-yellow-600 text-white'
                                          : 'bg-blue-600 hover:bg-blue-700 text-white'
                                  }`}
                                >
                                  {isActiveDriver && requestStatus === 'waiting' ? (
                                    <>
                                      <FaClock className="mr-1" />
                                      Waiting...
                                    </>
                                  ) : requestStatus === 'waiting' ? (
                                    <>
                                      <FaClock className="mr-1" />
                                      Request Pending...
                                    </>
                                  ) : (
                                    <>
                                      <FaPaperPlane className="mr-1" />
                                      Send Request
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                      })
                    )}
                  </div>
                )}
              </div>
              )}

              {/* Requests Tab - Pending Online/Offline Requests */}
              {activeDriverTab === 'requests' && (
              <div className="mb-6">
                {/* Online Requests */}
                <div className="mb-6">
                  <h3 className="font-medium mb-4 flex items-center">
                    <FaClock className="mr-2 text-blue-600" />
                    Pending Online Requests ({pendingRequestsCount})
                  </h3>

                  {pendingRequests.length === 0 ? (
                    <div className="text-center py-8 bg-gray-50 rounded-lg">
                      <FaCheckCircle className="text-green-400 text-3xl mx-auto mb-4" />
                      <p className="text-gray-600">No pending online requests</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {pendingRequests.map((request) => (
                        <div
                          key={request._id}
                          className="p-4 border-2 border-yellow-200 bg-yellow-50 rounded-lg"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-4">
                              <div className="w-10 h-10 rounded-full bg-yellow-200 flex items-center justify-center">
                                <FaUser className="text-yellow-600" />
                              </div>
                              <div>
                                <h4 className="font-medium text-gray-800">{request.driverName}</h4>
                                <p className="text-sm text-gray-600">
                                  <FaPhone className="inline mr-1" /> {request.driverPhone}
                                </p>
                                <p className="text-sm text-gray-500">
                                  🚗 {request.vehicleType?.toUpperCase()} • {request.vehicleNo}
                                </p>
                                <p className="text-xs text-yellow-700 mt-1">
                                  ⏱️ Expires in: {formatTimeRemaining(request.expiresAt)}
                                </p>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleApproveRequest(request._id)}
                                disabled={processingRequestId === request._id}
                                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 transition-colors text-sm font-medium"
                              >
                                {processingRequestId === request._id ? (
                                  <FaSpinner className="animate-spin" />
                                ) : (
                                  '✓ Approve'
                                )}
                              </button>
                              <button
                                onClick={() => handleRejectRequest(request._id, 'Rejected by admin')}
                                disabled={processingRequestId === request._id}
                                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 transition-colors text-sm font-medium"
                              >
                                {processingRequestId === request._id ? (
                                  <FaSpinner className="animate-spin" />
                                ) : (
                                  '✗ Reject'
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Offline Requests */}
                <div>
                  <h3 className="font-medium mb-4 flex items-center">
                    <FaClock className="mr-2 text-orange-600" />
                    Pending Offline Requests ({pendingOfflineRequestsCount})
                  </h3>

                  {pendingOfflineRequests.length === 0 ? (
                    <div className="text-center py-8 bg-gray-50 rounded-lg">
                      <FaCheckCircle className="text-green-400 text-3xl mx-auto mb-4" />
                      <p className="text-gray-600">No pending offline requests</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {pendingOfflineRequests.map((request) => (
                        <div
                          key={request._id}
                          className="p-4 border-2 border-orange-200 bg-orange-50 rounded-lg"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-4">
                              <div className="w-10 h-10 rounded-full bg-orange-200 flex items-center justify-center">
                                <FaUser className="text-orange-600" />
                              </div>
                              <div>
                                <h4 className="font-medium text-gray-800">{request.driverName}</h4>
                                <p className="text-sm text-gray-600">
                                  <FaPhone className="inline mr-1" /> {request.driverPhone}
                                </p>
                                <p className="text-sm text-gray-500">
                                  Reason: {request.reason || 'No reason provided'}
                                </p>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleApproveOfflineRequest(request._id)}
                                disabled={processingRequestId === request._id}
                                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400 transition-colors text-sm font-medium"
                              >
                                {processingRequestId === request._id ? (
                                  <FaSpinner className="animate-spin" />
                                ) : (
                                  '✓ Approve Offline'
                                )}
                              </button>
                              <button
                                onClick={() => handleRejectOfflineRequest(request._id, 'Rejected by admin')}
                                disabled={processingRequestId === request._id}
                                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:bg-gray-400 transition-colors text-sm font-medium"
                              >
                                {processingRequestId === request._id ? (
                                  <FaSpinner className="animate-spin" />
                                ) : (
                                  '✗ Reject'
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              )}

              {/* Navigation Buttons */}
              <div className="flex justify-between">
                <button
                  onClick={prevStep}
                  className="flex items-center px-4 py-2 text-gray-600 hover:text-gray-800"
                >
                  <FaArrowLeft className="mr-2" />
                  Back
                </button>
                <button
                  onClick={nextStep}
                  disabled={!selectedDriver}
                  className="flex items-center bg-blue-600 text-white px-6 py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:bg-gray-400 disabled:cursor-not-allowed"
                >
                  Continue with {selectedDriver ? selectedDriver.fullName : 'Selected Driver'}
                  <FaArrowRight className="ml-2" />
                </button>
              </div>
              </>
              )}
              </>
              )}
            </div>
          )}

          {/* Step 6: Final Confirmation */}
          {currentStep === 6 && (
            <div>
              <h2 className="text-xl font-semibold mb-6">Booking Confirmation</h2>
              
              {/* Complete Booking Summary */}
              <div className="space-y-4 mb-8">
                <div className="bg-gray-50 p-4 rounded-lg">
                  <h3 className="font-medium mb-3">Customer Details</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p><strong>Name:</strong> {userName}</p>
                      <p><strong>Phone:</strong> {userPhone}</p>
                    </div>
                    <div>
                      {existingUser ? (
                        <p className="text-green-600">✓ Existing Customer</p>
                      ) : (
                        <p className="text-blue-600">★ New Customer</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="bg-gray-50 p-4 rounded-lg">
                  <h3 className="font-medium mb-3">Trip Details</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p><strong>From:</strong> {currentBooth.name}</p>
                      <p><strong>To:</strong> {dropLocation}</p>
                    </div>
                    <div>
                      <p><strong>Distance:</strong> {fareEstimates?.distance || 'N/A'} km</p>
                      <p><strong>Est. Time:</strong> {selectedVehicle?.eta || 'N/A'}</p>
                    </div>
                  </div>
                </div>

                {/* Driver Details */}
                <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg">
                  <h3 className="font-medium mb-3">Assigned Driver</h3>
                  {selectedDriver ? (
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <p><strong>Name:</strong> {selectedDriver.fullName}</p>
                        <p><strong>Phone:</strong> {selectedDriver.mobileNo}</p>
                        <p><strong>Vehicle:</strong> {selectedDriver.vehicleNo}</p>
                      </div>
                      <div>
                        <p><strong>Type:</strong> {selectedDriver.vehicleType?.toUpperCase()}</p>
                        <p><strong>Queue Position:</strong> #{selectedDriver.queuePosition}</p>
                        <div className="flex items-center mt-2">
                          <span className="px-2 py-1 text-xs bg-green-100 text-green-800 rounded-full">
                            ✓ Selected from Queue
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <p className="text-gray-600">No driver selected</p>
                  )}
                </div>

                <div className="bg-green-50 border border-green-200 p-4 rounded-lg">
                  <h3 className="font-medium mb-3">Vehicle & Fare</h3>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center">
                      <div className="text-2xl mr-3 text-green-600">
                        {selectedVehicle?.icon}
                      </div>
                      <div>
                        <p className="font-medium">{selectedVehicle?.label}</p>
                        <p className="text-sm text-gray-600">
                          {fareEstimates?.distance || 'N/A'} km • {selectedVehicle?.eta || 'ETA N/A'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-3xl font-bold text-green-600">
                        {typeof selectedVehicle?.price === 'number' ? `₹${selectedVehicle.price}` : selectedVehicle?.price || 'N/A'}
                      </div>
                      <p className="text-sm text-gray-600">Total Fare</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Socket Connection Warning */}
              {!socketConnected && (
                <div className="bg-yellow-50 border border-yellow-200 p-4 rounded-lg mb-4">
                  <p className="text-yellow-800">
                    ⚠️ Socket connection lost. Please check your internet connection before booking.
                  </p>
                </div>
              )}

              {/* Confirmation Buttons */}
              <div className="flex justify-between">
                <button
                  onClick={prevStep}
                  className="flex items-center px-4 py-2 text-gray-600 hover:text-gray-800"
                >
                  <FaArrowLeft className="mr-2" />
                  Back
                </button>
                <button
                  onClick={() => {
                    console.log('🖱️ [Manual Booking] Confirm Booking button clicked!');
                    console.log('📊 [Manual Booking] Booking data:', {
                      selectedDriver: selectedDriver?._id,
                      selectedVehicle: selectedVehicle?.type,
                      customer: { name: userName, phone: userPhone },
                      trip: { from: currentBooth.name, to: dropLocation }
                    });

                    // Call confirmBooking directly - backend handles socket communication
                    confirmBooking();
                  }}
                  className="flex items-center bg-green-600 text-white px-8 py-3 rounded-lg hover:bg-green-700 transition-colors text-lg font-medium"
                  disabled={loading}
                >
                  {loading ? (
                    <>
                      <FaSpinner className="mr-2 animate-spin" />
                      Creating Booking...
                    </>
                  ) : (
                    <>
                      <FaCheckCircle className="mr-2" />
                      Confirm Booking
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
        </div>

          {/* Sidebar: Pending FM Requests */}
          <div className="w-80 flex-shrink-0">
            <div className="bg-white rounded-lg shadow-lg sticky top-4">
              <div className="px-4 py-3 border-b bg-gray-50 rounded-t-lg">
                <h3 className="font-semibold text-gray-800 flex items-center">
                  <FaClock className="mr-2 text-orange-500" />
                  Pending FM Requests
                  {pendingFmRequests.length > 0 && (
                    <span className="ml-2 bg-orange-500 text-white text-xs rounded-full px-2 py-0.5">
                      {pendingFmRequests.length}
                    </span>
                  )}
                </h3>
              </div>

              <div className="p-4 max-h-[calc(100vh-200px)] overflow-y-auto">
                {pendingFmRequests.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    <FaClipboardList className="text-4xl mx-auto mb-3 text-gray-300" />
                    <p className="text-sm">No pending requests</p>
                    <p className="text-xs mt-1">Submitted bookings will appear here</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {pendingFmRequests.map((request) => (
                      <div
                        key={request._id || request.bookingId}
                        className={`p-3 rounded-lg border transition-all ${
                          request.status === 'driver_assigned'
                            ? 'bg-green-50 border-green-200'
                            : request.status === 'cancelled_by_fm' || request.status === 'cancelled_by_admin'
                              ? 'bg-red-50 border-red-200'
                              : 'bg-orange-50 border-orange-200'
                        }`}
                      >
                        <div className="flex justify-between items-start mb-2">
                          <span className="text-xs font-mono text-gray-600">
                            {request.bookingId}
                          </span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${
                            request.status === 'driver_assigned'
                              ? 'bg-green-200 text-green-800'
                              : request.status === 'cancelled_by_fm' || request.status === 'cancelled_by_admin'
                                ? 'bg-red-200 text-red-800'
                                : 'bg-orange-200 text-orange-800'
                          }`}>
                            {request.status === 'driver_assigned' ? 'Assigned' :
                             request.status === 'cancelled_by_fm' ? 'FM Cancelled' :
                             request.status === 'cancelled_by_admin' ? 'Cancelled' : 'Pending'}
                          </span>
                        </div>

                        <p className="font-medium text-sm text-gray-900 truncate">
                          {request.userName || request.customer?.name}
                        </p>
                        <p className="text-xs text-gray-600 truncate">
                          To: {request.dropLocation?.address || request.dropLocation}
                        </p>
                        <div className="flex justify-between items-center mt-2">
                          <span className="text-xs text-gray-500">
                            {request.vehicleType?.toUpperCase()} • ₹{request.estimatedFare}
                          </span>
                          {request.status === 'pending_fm' && (
                            <button
                              onClick={() => cancelFmRequest(request._id)}
                              className="text-xs text-red-600 hover:text-red-800"
                            >
                              Cancel
                            </button>
                          )}
                        </div>

                        {/* Show OTPs for assigned requests */}
                        {request.status === 'driver_assigned' && (request.startOTP || request.endOTP) && (
                          <div className="mt-2 pt-2 border-t border-green-200 grid grid-cols-2 gap-2">
                            <div className="text-center bg-green-100 rounded p-1">
                              <p className="text-xs text-gray-600">Start</p>
                              <p className="font-mono font-bold text-green-700">{request.startOTP}</p>
                            </div>
                            <div className="text-center bg-red-100 rounded p-1">
                              <p className="text-xs text-gray-600">End</p>
                              <p className="font-mono font-bold text-red-700">{request.endOTP}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Refresh Button */}
                <button
                  onClick={fetchPendingFmRequests}
                  className="w-full mt-4 py-2 text-sm text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <FaSpinner className="text-xs" />
                  Refresh List
                </button>
              </div>
            </div>
          </div>
        </div>
    </div>
  );

  return (
    <>
      <Toaster position="top-right" />
      {renderContent()}
    </>
  );
};

export default ManualBooking;