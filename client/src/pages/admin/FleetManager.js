import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  FaSearch,
  FaClipboardList,
  FaUser,
  FaCar,
  FaMapMarkerAlt,
  FaPhone,
  FaFilter,
  FaCheckCircle,
  FaTimes,
  FaSpinner,
  FaClock,
  FaRupeeSign,
  FaMotorcycle,
  FaTaxi,
  FaBell,
  FaArrowLeft,
  FaPaperPlane
} from 'react-icons/fa';
import { MdRefresh } from 'react-icons/md';
import * as api from '../../services/api';
import { initializeSocket, getSocket } from '../../services/socket';
import { getImageUrl } from '../../utils/imageUtils';

/**
 * FleetManager - Enhanced with Open Bookings Tab
 *
 * Features:
 * - Tab 1: Open Bookings (pending_fm requests for driver assignment)
 * - Tab 2: Assigned Rides (last 24 hours)
 * - Sound notification for new requests
 * - Driver assignment with 60-second timer
 */
const FleetManager = () => {
  // Tab state
  const [activeTab, setActiveTab] = useState('open'); // 'open' | 'assigned'

  // Open Bookings state
  const [openBookings, setOpenBookings] = useState([]);
  const [loadingOpenBookings, setLoadingOpenBookings] = useState(true);
  const [openBookingsCount, setOpenBookingsCount] = useState(0);

  // Driver Assignment state
  const [selectedBooking, setSelectedBooking] = useState(null);
  const [showDriverAssignment, setShowDriverAssignment] = useState(false);
  const [availableDrivers, setAvailableDrivers] = useState([]);
  const [loadingDrivers, setLoadingDrivers] = useState(false);
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [assigning, setAssigning] = useState(false);
  const [assignmentTimer, setAssignmentTimer] = useState(60);
  const [waitingForDriver, setWaitingForDriver] = useState(false);
  const [assignmentResult, setAssignmentResult] = useState(null); // 'accepted' | 'rejected' | null
  const timerRef = useRef(null);

  // Socket state
  const [socket, setSocket] = useState(null);
  const [socketConnected, setSocketConnected] = useState(false);

  // Sound notification ref
  const audioRef = useRef(null);

  // Assigned Rides state (existing)
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterSource, setFilterSource] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [lastUpdate, setLastUpdate] = useState(null);

  // Format time ago
  const formatTimeAgo = (timestamp) => {
    if (!timestamp) return 'N/A';
    const now = new Date();
    const time = new Date(timestamp);
    const diffMs = now - time;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  };

  // Fetch rides from database (last 24 hours)
  const fetchRides = async () => {
    try {
      setLoading(true);

      // Calculate 24 hours ago
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Fetch multiple statuses to show full ride lifecycle
      const statuses = ['driver_assigned', 'ride_started', 'ride_ended', 'completed'];

      // Make parallel requests (one per status)
      const requests = statuses.map(status =>
        api.admin.getRides({
          status,
          skip: 0,
          limit: 100,
          sort: '-acceptedAt',
          startDate: last24h  // Only last 24 hours
        })
      );

      const responses = await Promise.all(requests);

      // Combine all results
      const allRides = responses.flatMap(response =>
        (response.success && response.data && response.data.rides) ? response.data.rides : []
      );

      // Remove duplicates (by _id) and sort by acceptedAt
      const uniqueRides = Array.from(
        new Map(allRides.map(ride => [ride._id, ride])).values()
      ).sort((a, b) =>
        new Date(b.acceptedAt || b.createdAt) - new Date(a.acceptedAt || a.createdAt)
      );

      setRides(uniqueRides);
      console.log('[Fleet Manager] Loaded', uniqueRides.length, 'rides from last 24 hours');
    } catch (error) {
      console.error('[Fleet Manager] Error fetching rides:', error);
      setRides([]);
    } finally {
      setLoading(false);
      setLastUpdate(new Date());
    }
  };

  // ============================================
  // OPEN BOOKINGS FUNCTIONS
  // ============================================

  // Fetch open bookings (pending_fm requests)
  const fetchOpenBookings = async () => {
    try {
      setLoadingOpenBookings(true);
      const response = await api.admin.getOpenBookings();

      if (response.success) {
        setOpenBookings(response.bookings || []);
        setOpenBookingsCount(response.count || 0);
        console.log('[Fleet Manager] Loaded', response.count, 'open bookings');
      }
    } catch (error) {
      console.error('[Fleet Manager] Error fetching open bookings:', error);
      setOpenBookings([]);
    } finally {
      setLoadingOpenBookings(false);
    }
  };

  // Fetch available drivers for selected booking (same logic as ManualBooking.js)
  const fetchAvailableDrivers = async (vehicleType) => {
    setLoadingDrivers(true);

    try {
      console.log('[Fleet Manager] Fetching drivers for vehicle type:', vehicleType);

      // Fetch all drivers and filter by queue membership and vehicle type
      const response = await api.admin.getAllDrivers();
      const allDrivers = response.data || [];
      console.log('[Fleet Manager] Total drivers from API:', allDrivers.length);

      // Filter drivers in queue (both online and not reachable)
      const inQueueDrivers = allDrivers.filter(driver => driver.inQueue || driver.isOnline);
      console.log('[Fleet Manager] Drivers in queue (inQueue OR isOnline):', inQueueDrivers.length);

      // Filter by vehicle type
      const vehicleMatchDrivers = inQueueDrivers.filter(driver => {
        return !vehicleType || driver.vehicleType === vehicleType;
      });
      console.log('[Fleet Manager] Vehicle match drivers:', vehicleMatchDrivers.length, `(type: ${vehicleType})`);

      // Filter by current ride status (no active rides)
      const availableDriversList = vehicleMatchDrivers.filter(driver => {
        return !driver.currentRide;
      });
      console.log('[Fleet Manager] Available drivers (no currentRide):', availableDriversList.length);

      // Sort by: 1) Connected drivers first, 2) Then by queue entry time/position
      const sortedDrivers = availableDriversList.sort((a, b) => {
        // Priority 1: Connected drivers first
        const aConnected = a.connectionStatus === 'connected' || (a.isOnline && !a.connectionStatus);
        const bConnected = b.connectionStatus === 'connected' || (b.isOnline && !b.connectionStatus);

        if (aConnected && !bConnected) return -1;
        if (!aConnected && bConnected) return 1;

        // Priority 2: Sort by queue entry time or position
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
      console.log('[Fleet Manager] Final sorted drivers:', finalDrivers.length);

      setAvailableDrivers(finalDrivers);

      // If there's a partially selected driver (from restored state), update with full info
      setSelectedDriver(prevDriver => {
        if (prevDriver && prevDriver._id) {
          const fullDriverInfo = finalDrivers.find(d => d._id === prevDriver._id || d._id.toString() === prevDriver._id.toString());
          if (fullDriverInfo) {
            console.log('[Fleet Manager] Updated selected driver with full info:', fullDriverInfo.fullName);
            return fullDriverInfo;
          }
        }
        return prevDriver;
      });

      if (finalDrivers.length === 0) {
        console.warn('[Fleet Manager] No available drivers found');
      }
    } catch (error) {
      console.error('[Fleet Manager] Error fetching drivers:', error);
      setAvailableDrivers([]);
    } finally {
      setLoadingDrivers(false);
    }
  };

  // Handle opening driver assignment view
  const openDriverAssignment = async (booking) => {
    setSelectedBooking(booking);
    setShowDriverAssignment(true);
    setAssignmentResult(null);

    // Fetch latest booking data to check for pending driver assignment
    try {
      const response = await api.admin.getFmBookingDetails(booking._id);
      if (response.success && response.booking) {
        const latestBooking = response.booking;
        setSelectedBooking(prev => ({ ...prev, ...latestBooking }));

        // Check if there's a pending driver assignment with active timer
        if (latestBooking.targetDriver && latestBooking.expiresAt) {
          const expiresAt = new Date(latestBooking.expiresAt);
          const now = new Date();
          const remainingMs = expiresAt - now;
          const remainingSeconds = Math.floor(remainingMs / 1000);

          if (remainingSeconds > 0) {
            console.log('[Fleet Manager] Restoring pending driver assignment, remaining:', remainingSeconds, 's');

            // Find the driver in available drivers or create a basic object
            const targetDriverId = latestBooking.targetDriver.id;
            const targetDriverName = latestBooking.targetDriver.name;

            // Set the selected driver (will be updated once drivers are fetched)
            setSelectedDriver({
              _id: targetDriverId,
              fullName: targetDriverName
            });

            // Restore waiting state
            setWaitingForDriver(true);
            setAssignmentTimer(remainingSeconds);

            // Start countdown timer from remaining time
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = setInterval(() => {
              setAssignmentTimer(prev => {
                if (prev <= 1) {
                  clearInterval(timerRef.current);
                  setAssignmentResult('expired');
                  setWaitingForDriver(false);
                  return 0;
                }
                return prev - 1;
              });
            }, 1000);
          } else {
            // Timer has expired, reset state
            setSelectedDriver(null);
            setWaitingForDriver(false);
          }
        } else {
          // No pending assignment
          setSelectedDriver(null);
          setWaitingForDriver(false);
        }
      } else {
        // Couldn't fetch latest data, reset state
        setSelectedDriver(null);
        setWaitingForDriver(false);
      }
    } catch (error) {
      console.error('[Fleet Manager] Error fetching booking details:', error);
      setSelectedDriver(null);
      setWaitingForDriver(false);
    }

    await fetchAvailableDrivers(booking.vehicleType);
  };

  // Handle assigning driver to booking
  const assignDriver = async () => {
    if (!selectedBooking || !selectedDriver) return;

    try {
      setAssigning(true);
      const response = await api.admin.assignDriverToBooking(selectedBooking._id, selectedDriver._id);

      if (response.success) {
        // Start waiting for driver response
        setWaitingForDriver(true);
        setAssignmentTimer(60);

        // Start countdown timer
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setAssignmentTimer(prev => {
            if (prev <= 1) {
              clearInterval(timerRef.current);
              setAssignmentResult('expired');
              setWaitingForDriver(false);
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      } else {
        alert(response.message || 'Failed to assign driver');
      }
    } catch (error) {
      console.error('[Fleet Manager] Error assigning driver:', error);
      alert('Failed to assign driver: ' + (error.response?.data?.message || error.message));
    } finally {
      setAssigning(false);
    }
  };

  // Handle sending request directly to a driver (old UI style)
  const handleSendRequest = async (driver) => {
    if (waitingForDriver || !selectedBooking) return;

    // Warn if driver is disconnected
    const isDisconnected = driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue);
    if (isDisconnected) {
      const proceed = window.confirm(
        `⚠️ ${driver.fullName} is currently not reachable.\n\nThey may not receive the notification immediately. Continue anyway?`
      );
      if (!proceed) return;
    }

    setSelectedDriver(driver);
    setAssigning(true);

    try {
      console.log('[Fleet Manager] Sending request to driver:', driver.fullName);
      const response = await api.admin.assignDriverToBooking(selectedBooking._id, driver._id);

      if (response.success) {
        // Check if driver was actually notified
        if (response.driverNotified === false) {
          console.warn('[Fleet Manager] ⚠️ Driver was NOT notified - socket may be disconnected');
          // Show a non-blocking warning but continue with timer
          // The driver might still see it when they reconnect
        }
        
        // Start waiting for driver response
        setWaitingForDriver(true);
        setAssignmentTimer(60);

        // Store notification status for UI display
        setSelectedBooking(prev => ({
          ...prev,
          driverNotified: response.driverNotified !== false
        }));

        // Start countdown timer
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = setInterval(() => {
          setAssignmentTimer(prev => {
            if (prev <= 1) {
              clearInterval(timerRef.current);
              setAssignmentResult('expired');
              setWaitingForDriver(false);
              return 0;
            }
            return prev - 1;
          });
        }, 1000);
      } else {
        alert(response.message || 'Failed to assign driver');
        setSelectedDriver(null);
      }
    } catch (error) {
      console.error('[Fleet Manager] Error sending request:', error);
      alert('Failed to send request: ' + (error.response?.data?.message || error.message));
      setSelectedDriver(null);
    } finally {
      setAssigning(false);
    }
  };;

  // Handle cancelling booking
  const cancelBooking = async (rideId, reason) => {
    const cancelReason = reason || prompt('Enter cancellation reason:');
    if (!cancelReason) return;

    try {
      const response = await api.admin.cancelBookingByFm(rideId, cancelReason);

      if (response.success) {
        // Remove from open bookings list
        setOpenBookings(prev => prev.filter(b => b._id !== rideId));
        setOpenBookingsCount(prev => prev - 1);

        if (showDriverAssignment && selectedBooking?._id === rideId) {
          closeDriverAssignment();
        }
      }
    } catch (error) {
      console.error('[Fleet Manager] Error cancelling booking:', error);
      alert('Failed to cancel booking');
    }
  };

  // Close driver assignment view
  const closeDriverAssignment = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setShowDriverAssignment(false);
    setSelectedBooking(null);
    setSelectedDriver(null);
    setWaitingForDriver(false);
    setAssignmentResult(null);
    setAssignmentTimer(60);
  };

  // Play notification sound
  const playNotificationSound = () => {
    try {
      if (audioRef.current) {
        audioRef.current.currentTime = 0;
        audioRef.current.play().catch(e => console.log('Audio play failed:', e));
      }
    } catch (error) {
      console.log('Notification sound error:', error);
    }
  };

  // ============================================
  // SOCKET INITIALIZATION AND HANDLERS
  // ============================================

  // Initialize socket connection
  useEffect(() => {
    const initSocket = async () => {
      const token = localStorage.getItem('adminToken');
      if (!token) return;

      try {
        const socketResult = initializeSocket(token);
        let actualSocket;

        if (socketResult && typeof socketResult.then === 'function') {
          actualSocket = await socketResult;
        } else {
          actualSocket = socketResult;
        }

        if (actualSocket) {
          setSocket(actualSocket);
          setSocketConnected(actualSocket.connected);
        }
      } catch (error) {
        console.error('[Fleet Manager] Socket initialization error:', error);
      }
    };

    initSocket();
  }, []);

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    // Handler for new open booking
    const handleNewOpenBooking = (data) => {
      console.log('[Fleet Manager] New open booking received:', data);

      // Add to open bookings list
      setOpenBookings(prev => {
        // Check if already exists
        if (prev.some(b => b._id === data.rideId || b.bookingId === data.bookingId)) {
          return prev;
        }
        return [{
          _id: data.rideId,
          bookingId: data.bookingId,
          queueNumber: data.queueNumber,
          customer: data.user,
          pickupLocation: data.pickupLocation,
          dropLocation: data.dropLocation,
          vehicleType: data.vehicleType,
          estimatedFare: data.estimatedFare,
          distance: data.distance,
          paymentMethod: data.paymentMethod,
          paymentStatus: data.paymentStatus,
          submittedAt: data.submittedAt,
          createdBy: data.createdBy?.name
        }, ...prev];
      });

      setOpenBookingsCount(prev => prev + 1);

      // Play notification sound
      playNotificationSound();

      // Switch to open bookings tab if not already there
      if (activeTab !== 'open') {
        // Don't auto-switch, just show badge
      }
    };

    // Handler for booking cancelled by admin
    const handleBookingCancelledByAdmin = (data) => {
      console.log('[Fleet Manager] Booking cancelled by admin:', data);

      setOpenBookings(prev => prev.filter(b => b._id !== data.rideId && b.bookingId !== data.bookingId));
      setOpenBookingsCount(prev => Math.max(0, prev - 1));

      // If this was the booking being assigned, close the assignment view
      if (selectedBooking && (selectedBooking._id === data.rideId || selectedBooking.bookingId === data.bookingId)) {
        if (timerRef.current) clearInterval(timerRef.current);
        setWaitingForDriver(false);
        setAssignmentResult('cancelled');
        alert('This booking was cancelled by the admin.');
      }
    };

    // Handler for driver accepted
    const handleDriverAccepted = (data) => {
      console.log('[Fleet Manager] Driver accepted:', data);

      // Play notification sound when driver accepts
      playNotificationSound();

      if (selectedBooking && (selectedBooking._id === data.rideId || selectedBooking.bookingId === data.bookingId)) {
        if (timerRef.current) clearInterval(timerRef.current);
        setWaitingForDriver(false);
        setAssignmentResult('accepted');

        // Update the selected booking with OTPs
        setSelectedBooking(prev => ({
          ...prev,
          ...data,
          startOTP: data.startOTP,
          endOTP: data.endOTP,
          driverName: data.driverName,
          driverPhone: data.driverPhone,
          vehicleNumber: data.vehicleNumber,
          queueNumber: data.queueNumber
        }));
      }

      // Remove from open bookings
      setOpenBookings(prev => prev.filter(b => b._id !== data.rideId && b.bookingId !== data.bookingId));
      setOpenBookingsCount(prev => Math.max(0, prev - 1));

      // Refresh assigned rides
      fetchRides();
    };

    // Handler for driver rejected
    const handleDriverRejected = (data) => {
      console.log('[Fleet Manager] Driver rejected:', data);

      if (selectedBooking && (selectedBooking._id === data.rideId || selectedBooking.bookingId === data.bookingId)) {
        if (timerRef.current) clearInterval(timerRef.current);
        setWaitingForDriver(false);
        setAssignmentResult('rejected');
        setSelectedDriver(null);

        alert(`Driver rejected the ride: ${data.reason || 'No reason provided'}\nPlease select another driver.`);
      }
    };

    // Register event listeners
    socket.on('newOpenBooking', handleNewOpenBooking);
    socket.on('bookingCancelledByAdmin', handleBookingCancelledByAdmin);
    socket.on('driverAssigned', handleDriverAccepted);
    socket.on('driverAcceptedFmBooking', handleDriverAccepted);
    socket.on('driverRejectedFmBooking', handleDriverRejected);

    return () => {
      socket.off('newOpenBooking', handleNewOpenBooking);
      socket.off('bookingCancelledByAdmin', handleBookingCancelledByAdmin);
      socket.off('driverAssigned', handleDriverAccepted);
      socket.off('driverAcceptedFmBooking', handleDriverAccepted);
      socket.off('driverRejectedFmBooking', handleDriverRejected);
    };
  }, [socket, selectedBooking, activeTab]);

  // Fetch data on mount
  useEffect(() => {
    fetchOpenBookings();
    fetchRides();

    // Set up periodic refresh for open bookings
    const interval = setInterval(fetchOpenBookings, 30000);
    return () => clearInterval(interval);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Filter rides based on search, source, and status filters
  const filteredRides = useMemo(() => {
    return rides.filter(ride => {
      // Search filter
      const searchLower = searchQuery.toLowerCase();
      const matchesSearch = !searchQuery ||
        ride.userName?.toLowerCase().includes(searchLower) ||
        ride.userPhone?.includes(searchQuery) ||
        ride.driverName?.toLowerCase().includes(searchLower) ||
        ride.driverPhone?.includes(searchQuery) ||
        ride.bookingId?.toLowerCase().includes(searchLower) ||
        ride.rideId?.toLowerCase().includes(searchLower);

      // Source filter
      const matchesSource =
        filterSource === 'all' ||
        (filterSource === 'manual' && ride.bookingSource === 'manual') ||
        (filterSource === 'app' && ride.bookingSource === 'app');

      // Status filter
      const matchesStatus =
        filterStatus === 'all' ||
        ride.status === filterStatus;

      return matchesSearch && matchesSource && matchesStatus;
    });
  }, [rides, searchQuery, filterSource, filterStatus]);

  // Calculate stats
  const stats = useMemo(() => ({
    total: filteredRides.length,
    manual: filteredRides.filter(r => r.bookingSource === 'manual').length,
    app: filteredRides.filter(r => r.bookingSource === 'app').length,
    assigned: filteredRides.filter(r => r.status === 'driver_assigned').length,
    inProgress: filteredRides.filter(r => r.status === 'ride_started').length,
    arrived: filteredRides.filter(r => r.status === 'ride_ended').length,
    completed: filteredRides.filter(r => r.status === 'completed').length,
    cancelled: filteredRides.filter(r => r.status === 'cancelled').length,
  }), [filteredRides]);

  // Status Badge Component
  const StatusBadge = ({ status }) => {
    const getStatusConfig = (status) => {
      switch(status) {
        case 'pending':
          return {
            label: 'Waiting for Driver',
            color: 'bg-yellow-100 text-yellow-800 border-yellow-300',
            icon: '⏳'
          };
        case 'driver_assigned':
          return {
            label: 'Driver Assigned',
            color: 'bg-blue-100 text-blue-800 border-blue-300',
            icon: '✓'
          };
        case 'ride_started':
          return {
            label: 'In Progress',
            color: 'bg-green-100 text-green-800 border-green-300',
            icon: '🚗'
          };
        case 'ride_ended':
          return {
            label: 'Arrived',
            color: 'bg-purple-100 text-purple-800 border-purple-300',
            icon: '🏁'
          };
        case 'completed':
          return {
            label: 'Completed',
            color: 'bg-gray-100 text-gray-800 border-gray-300',
            icon: '✅'
          };
        case 'cancelled':
          return {
            label: 'Cancelled',
            color: 'bg-red-100 text-red-800 border-red-300',
            icon: '❌'
          };
        default:
          return {
            label: status || 'Unknown',
            color: 'bg-gray-100 text-gray-800 border-gray-300',
            icon: '•'
          };
      }
    };

    const config = getStatusConfig(status);

    return (
      <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border ${config.color}`}>
        <span className="mr-1">{config.icon}</span>
        {config.label}
      </span>
    );
  };

  // Ride Card Component
  const RideCard = ({ ride }) => {
    const isManual = ride.bookingSource === 'manual';

    return (
      <div
        className={`bg-white rounded-lg shadow-md p-4 border-l-4 transition-all hover:shadow-lg ${
          isManual ? 'border-l-blue-500' : 'border-l-green-500'
        }`}
      >
        {/* Header: Booking badge and time */}
        <div className="flex justify-between items-start mb-3">
          <div className="flex flex-col gap-2">
            <span className={`px-2 py-1 rounded text-xs font-medium ${
              isManual
                ? 'bg-blue-100 text-blue-800'
                : 'bg-green-100 text-green-800'
            }`}>
              {isManual ? '📋 MANUAL BOOKING' : '📱 APP BOOKING'}
            </span>
            <StatusBadge status={ride.status} />
          </div>
          <span className="text-xs text-gray-500">
            {formatTimeAgo(ride.acceptedAt || ride.createdAt)}
          </span>
        </div>

        {/* Passenger Info */}
        <div className="mb-3 pb-3 border-b border-gray-200">
          <div className="flex items-center gap-2 mb-1">
            <FaUser className="text-gray-400 text-sm" />
            <span className="font-semibold text-gray-900">
              {ride.userName || 'N/A'}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <FaPhone className="text-gray-400 text-xs" />
            <span>{ride.userPhone || 'N/A'}</span>
          </div>
        </div>

        {/* Driver Info */}
        <div className="mb-3 pb-3 border-b border-gray-200">
          <div className="flex items-center gap-2 mb-1">
            <FaCar className="text-gray-400 text-sm" />
            <span className="font-semibold text-gray-900">
              {ride.driverName || 'N/A'}
            </span>
          </div>
          <div className="text-sm text-gray-600 space-y-1">
            <div className="flex items-center gap-2">
              <FaPhone className="text-gray-400 text-xs" />
              <span>{ride.driverPhone || 'N/A'}</span>
            </div>
            {ride.driverVehicleNo && (
              <div className="text-xs">
                Vehicle: <span className="font-mono font-medium">{ride.driverVehicleNo}</span>
              </div>
            )}
          </div>
        </div>

        {/* OTPs - Prominent Display */}
        <div className="mb-3 pb-3 border-b border-gray-200">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-green-50 p-2 rounded border border-green-200">
              <div className="text-xs text-gray-600 mb-1">Start OTP</div>
              <div className="text-lg font-mono font-bold text-green-700">
                {ride.startOTP || '----'}
              </div>
            </div>
            <div className="bg-red-50 p-2 rounded border border-red-200">
              <div className="text-xs text-gray-600 mb-1">End OTP</div>
              <div className="text-lg font-mono font-bold text-red-700">
                {ride.endOTP || '----'}
              </div>
            </div>
          </div>
        </div>

        {/* Location Info */}
        <div className="mb-3 text-sm">
          <div className="flex items-start gap-2 mb-2">
            <FaMapMarkerAlt className="text-green-500 text-xs mt-1 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-gray-500 text-xs">From</div>
              <div className="font-medium text-gray-900">
                {ride.pickupLocation?.boothName || ride.pickupStation || 'N/A'}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <FaMapMarkerAlt className="text-red-500 text-xs mt-1 flex-shrink-0" />
            <div className="flex-1">
              <div className="text-gray-500 text-xs">To</div>
              <div className="font-medium text-gray-900">
                {ride.dropLocation?.address || ride.destination || 'N/A'}
              </div>
            </div>
          </div>
        </div>

        {/* Footer: Metadata */}
        <div className="flex flex-wrap gap-2 text-xs text-gray-500">
          <span className="bg-gray-100 px-2 py-1 rounded">
            Queue: #{ride.queueNumber || 'N/A'}
          </span>
          <span className="bg-gray-100 px-2 py-1 rounded">
            {ride.bookingId || ride.rideId || 'N/A'}
          </span>
          <span className="bg-gray-100 px-2 py-1 rounded">
            {ride.vehicleType?.toUpperCase() || 'N/A'}
          </span>
          <span className="bg-gray-100 px-2 py-1 rounded">
            ₹{ride.estimatedFare || ride.fare || 'N/A'}
          </span>
        </div>
      </div>
    );
  };

  // Vehicle icon helper
  const getVehicleIcon = (vehicleType) => {
    switch(vehicleType) {
      case 'bike': return <FaMotorcycle className="text-lg" />;
      case 'auto': return <FaTaxi className="text-lg" />;
      case 'car': return <FaCar className="text-lg" />;
      default: return <FaCar className="text-lg" />;
    }
  };

  // Open Booking Card Component
  const OpenBookingCard = ({ booking, onAssign, onCancel }) => (
    <div className="bg-white rounded-lg shadow-md p-4 border-l-4 border-l-orange-500 hover:shadow-lg transition-all">
      {/* Header */}
      <div className="flex justify-between items-start mb-3">
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded text-xs font-medium bg-orange-100 text-orange-800">
            ⏳ PENDING ASSIGNMENT
          </span>
          <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-700">
            {getVehicleIcon(booking.vehicleType)}
            <span className="ml-1">{booking.vehicleType?.toUpperCase()}</span>
          </span>
        </div>
        <span className="text-xs text-gray-500">
          {formatTimeAgo(booking.submittedAt)}
        </span>
      </div>

      {/* Customer Info */}
      <div className="mb-3 pb-3 border-b border-gray-200">
        <div className="flex items-center gap-2 mb-1">
          <FaUser className="text-gray-400 text-sm" />
          <span className="font-semibold text-gray-900">
            {booking.customer?.name || booking.userName || 'N/A'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-600">
          <FaPhone className="text-gray-400 text-xs" />
          <span>{booking.customer?.phone || booking.userPhone || 'N/A'}</span>
        </div>
      </div>

      {/* Location Info */}
      <div className="mb-3 text-sm">
        <div className="flex items-start gap-2 mb-2">
          <FaMapMarkerAlt className="text-green-500 text-xs mt-1 flex-shrink-0" />
          <div className="flex-1">
            <div className="text-gray-500 text-xs">From</div>
            <div className="font-medium text-gray-900">
              {booking.pickupLocation?.boothName || 'N/A'}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <FaMapMarkerAlt className="text-red-500 text-xs mt-1 flex-shrink-0" />
          <div className="flex-1">
            <div className="text-gray-500 text-xs">To</div>
            <div className="font-medium text-gray-900">
              {booking.dropLocation?.address || 'N/A'}
            </div>
          </div>
        </div>
      </div>

      {/* Footer: Metadata and Actions */}
      <div className="flex justify-between items-center">
        <div className="flex flex-wrap gap-2 text-xs text-gray-500">
          <span className="bg-gray-100 px-2 py-1 rounded">
            ₹{booking.estimatedFare || 'N/A'}
          </span>
          <span className="bg-gray-100 px-2 py-1 rounded">
            {booking.distance ? `${booking.distance} km` : 'N/A'}
          </span>
          <span className={`px-2 py-1 rounded ${booking.paymentMethod === 'cash' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
            {booking.paymentMethod === 'cash' ? '💵 Cash' : '📱 UPI'}
          </span>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onCancel(booking._id)}
            className="px-3 py-1 text-sm text-red-600 border border-red-300 rounded hover:bg-red-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onAssign(booking)}
            className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
          >
            Assign Driver
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      {/* Notification Sound */}
      <audio ref={audioRef} preload="auto">
        <source src="/notification.mp3" type="audio/mpeg" />
        <source src="/notification.wav" type="audio/wav" />
      </audio>

      {/* Driver Assignment View is now rendered INLINE in the Open Bookings tab below */}

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <FaClipboardList className="text-3xl text-blue-600" />
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Fleet Manager</h1>
              <p className="text-sm text-gray-500">Manage bookings and assign drivers</p>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200 mb-4">
          <button
            onClick={() => setActiveTab('open')}
            className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors relative ${
              activeTab === 'open'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FaBell className="inline mr-2" />
            Open Bookings
            {openBookingsCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full h-5 w-5 flex items-center justify-center">
                {openBookingsCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('assigned')}
            className={`px-6 py-3 font-medium text-sm border-b-2 transition-colors ${
              activeTab === 'assigned'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FaClipboardList className="inline mr-2" />
            Assigned Rides
          </button>
        </div>

        {/* Tab Content: Open Bookings */}
        {activeTab === 'open' && (
          <div className="mb-4">
            {/* INLINE Driver Assignment View */}
            {showDriverAssignment && selectedBooking ? (
              <div className="bg-white rounded-lg shadow-lg">
                {/* Header with back button */}
                <div className="border-b border-gray-200 px-6 py-4">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={closeDriverAssignment}
                      className="p-2 hover:bg-gray-100 rounded-full transition-colors"
                    >
                      <FaArrowLeft className="text-gray-600" />
                    </button>
                    <div>
                      <h2 className="text-xl font-bold text-gray-900">Assign Driver</h2>
                      <p className="text-sm text-gray-500">
                        Booking #{selectedBooking.bookingId}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Content */}
                <div className="p-6">
                  {/* Assignment Result - Success */}
                  {assignmentResult === 'accepted' && (
                    <div className="mb-6 p-6 bg-green-50 border-2 border-green-200 rounded-lg">
                      <div className="flex items-center gap-3 mb-4">
                        <FaCheckCircle className="text-4xl text-green-500" />
                        <div>
                          <h3 className="text-xl font-bold text-green-800">Driver Assigned Successfully!</h3>
                          <p className="text-sm text-green-600">The driver has accepted the ride.</p>
                        </div>
                      </div>
                      {/* OTPs Display - BIGGER */}
                      <div className="grid grid-cols-2 gap-6 mt-6">
                        <div className="bg-green-100 p-4 rounded-lg border-2 border-green-300 text-center">
                          <div className="text-sm text-green-600 mb-2">Start OTP</div>
                          <div className="text-4xl font-mono font-bold text-green-800">
                            {selectedBooking.startOTP || '----'}
                          </div>
                        </div>
                        <div className="bg-red-100 p-4 rounded-lg border-2 border-red-300 text-center">
                          <div className="text-sm text-red-600 mb-2">End OTP</div>
                          <div className="text-4xl font-mono font-bold text-red-800">
                            {selectedBooking.endOTP || '----'}
                          </div>
                        </div>
                      </div>
                      {selectedBooking.queueNumber && (
                        <div className="mt-4 text-center">
                          <span className="text-gray-600">Queue Number: </span>
                          <span className="font-bold text-xl">#{selectedBooking.queueNumber}</span>
                        </div>
                      )}
                      <button
                        onClick={closeDriverAssignment}
                        className="w-full mt-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium text-lg"
                      >
                        Done
                      </button>
                    </div>
                  )}

                  {/* Assignment Result - Rejected */}
                  {assignmentResult === 'rejected' && (
                    <div className="mb-6 p-4 bg-yellow-50 border-2 border-yellow-200 rounded-lg">
                      <div className="flex items-center gap-3">
                        <FaTimes className="text-3xl text-yellow-500" />
                        <div>
                          <h3 className="text-lg font-bold text-yellow-800">Driver Rejected</h3>
                          <p className="text-sm text-yellow-600">Please select another driver.</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Assignment Result - Expired */}
                  {assignmentResult === 'expired' && (
                    <div className="mb-6 p-4 bg-red-50 border-2 border-red-200 rounded-lg">
                      <div className="flex items-center gap-3">
                        <FaClock className="text-3xl text-red-500" />
                        <div>
                          <h3 className="text-lg font-bold text-red-800">Request Expired</h3>
                          <p className="text-sm text-red-600">Driver did not respond in time. Please select another driver.</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Waiting for Driver - BIGGER Timer UI */}
                  {waitingForDriver && !assignmentResult && (
                    <div className={`mb-8 p-8 border-2 rounded-xl text-center transition-all ${
                      assignmentTimer <= 10
                        ? 'bg-red-50 border-red-300 animate-pulse'
                        : 'bg-yellow-50 border-yellow-300'
                    }`}>
                      {/* Driver Info */}
                      <div className="flex items-center justify-center gap-4 mb-6">
                        {selectedDriver?.driverSelfie ? (
                          <img
                            src={getImageUrl(selectedDriver.driverSelfie)}
                            alt={selectedDriver.fullName}
                            className="w-20 h-20 rounded-full object-cover border-4 border-gray-200"
                          />
                        ) : (
                          <div className="w-20 h-20 rounded-full bg-gray-200 flex items-center justify-center">
                            <FaUser className="text-gray-400 text-3xl" />
                          </div>
                        )}
                        <div className="text-left">
                          <h3 className={`text-2xl font-bold ${assignmentTimer <= 10 ? 'text-red-800' : 'text-yellow-800'}`}>
                            Waiting for Response
                          </h3>
                          <p className={`text-lg ${assignmentTimer <= 10 ? 'text-red-600' : 'text-yellow-700'}`}>
                            Requesting {selectedDriver?.fullName}...
                          </p>
                        </div>
                      </div>

                      {/* Progress Bar - BIGGER */}
                      <div className="w-full bg-gray-200 rounded-full h-4 mb-6 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-1000 ${
                            assignmentTimer <= 10 ? 'bg-red-500' : 'bg-yellow-500'
                          }`}
                          style={{ width: `${(assignmentTimer / 60) * 100}%` }}
                        />
                      </div>

                      {/* Timer Display - MUCH BIGGER */}
                      <div className={`text-7xl font-mono font-bold mb-6 ${
                        assignmentTimer <= 10 ? 'text-red-600' : 'text-yellow-700'
                      }`}>
                        {assignmentTimer}s
                      </div>

                      {/* Cancel Button */}
                      <button
                        onClick={() => {
                          if (timerRef.current) clearInterval(timerRef.current);
                          setWaitingForDriver(false);
                          setSelectedDriver(null);
                          setAssignmentTimer(60);
                        }}
                        className="px-8 py-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors font-medium text-lg"
                      >
                        Cancel Request
                      </button>

                      {/* Notification Status */}
                      {selectedBooking.driverNotified === false ? (
                        <div className="mt-4 p-3 bg-orange-100 border border-orange-300 rounded-lg">
                          <p className="text-sm text-orange-700 font-medium">
                            ⚠️ Driver may not have received notification (socket disconnected)
                          </p>
                          <p className="text-xs text-orange-600 mt-1">
                            Request is saved. Driver will see it when they reconnect.
                          </p>
                        </div>
                      ) : (
                        <p className={`text-sm mt-4 ${assignmentTimer <= 10 ? 'text-red-500 font-bold' : 'text-yellow-600'}`}>
                          {assignmentTimer <= 10 ? '⚠️ Request expiring soon!' : 'Driver will receive notification on their app'}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Booking Details */}
                  {!assignmentResult && (
                    <>
                      <div className="bg-gray-50 rounded-lg p-4 mb-6">
                        <h3 className="font-semibold text-gray-700 mb-3">Booking Details</h3>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                          <div>
                            <span className="text-gray-500">Customer:</span>
                            <span className="ml-2 font-medium">{selectedBooking.customer?.name || selectedBooking.userName}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Phone:</span>
                            <span className="ml-2 font-medium">{selectedBooking.customer?.phone || selectedBooking.userPhone}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Vehicle:</span>
                            <span className="ml-2 font-medium">{selectedBooking.vehicleType?.toUpperCase()}</span>
                          </div>
                          <div>
                            <span className="text-gray-500">Fare:</span>
                            <span className="ml-2 font-medium">₹{selectedBooking.estimatedFare}</span>
                          </div>
                          <div className="col-span-2">
                            <span className="text-gray-500">Drop:</span>
                            <span className="ml-2 font-medium">{selectedBooking.dropLocation?.address}</span>
                          </div>
                        </div>
                      </div>

                      {/* Driver Selection */}
                      {!waitingForDriver && (
                        <>
                          <h3 className="font-semibold text-gray-700 mb-3">Select Driver</h3>
                          {loadingDrivers ? (
                            <div className="flex items-center justify-center py-8">
                              <FaSpinner className="animate-spin text-2xl text-blue-500 mr-2" />
                              <span>Loading drivers...</span>
                            </div>
                          ) : availableDrivers.length === 0 ? (
                            <div className="text-center py-8 bg-gray-50 rounded-lg">
                              <FaUser className="text-gray-400 text-3xl mx-auto mb-4" />
                              <p className="text-gray-600 font-medium">No {selectedBooking.vehicleType?.toUpperCase()} drivers available</p>
                              <p className="text-gray-500 text-sm">Please check queue management or try a different vehicle type</p>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              {availableDrivers.map((driver, index) => {
                                const isSelected = selectedDriver?._id === driver._id;
                                const isDisconnected = driver.connectionStatus === 'disconnected' || (!driver.isOnline && driver.inQueue);

                                return (
                                  <div
                                    key={driver._id}
                                    onClick={() => setSelectedDriver(driver)}
                                    className={`p-4 border-2 rounded-lg transition-all cursor-pointer ${
                                      isSelected
                                        ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                                        : driver.isVehicleTypeMismatch
                                          ? 'border-orange-200 bg-orange-50 hover:border-orange-300'
                                          : isDisconnected
                                            ? 'border-yellow-200 bg-yellow-50/50 hover:border-yellow-300'
                                            : index === 0
                                              ? 'border-green-200 bg-green-50 hover:border-green-300'
                                              : 'border-gray-200 bg-gray-50 hover:border-gray-300'
                                    }`}
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center space-x-4">
                                        {/* Queue Position Badge */}
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

                                            {/* Connection Status Badge */}
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

                                          {/* Last Seen Time for Disconnected Drivers */}
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
                                                (Expected: {selectedBooking.vehicleType?.toUpperCase()})
                                              </span>
                                            )}
                                          </p>
                                        </div>
                                      </div>

                                      {/* Driver Stats */}
                                      <div className="text-right flex flex-col items-end gap-1">
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
                                        {/* Send Request Button */}
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleSendRequest(driver);
                                          }}
                                          disabled={waitingForDriver || assignmentResult === 'accepted' || assigning}
                                          className={`mt-2 flex items-center px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                                            selectedDriver?._id === driver._id && waitingForDriver
                                              ? 'bg-yellow-200 text-yellow-800 cursor-not-allowed'
                                              : waitingForDriver || assignmentResult === 'accepted'
                                                ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                                                : assigning && selectedDriver?._id === driver._id
                                                  ? 'bg-blue-400 text-white cursor-wait'
                                                  : isDisconnected
                                                    ? 'bg-yellow-500 hover:bg-yellow-600 text-white'
                                                    : 'bg-blue-600 hover:bg-blue-700 text-white'
                                          }`}
                                        >
                                          {selectedDriver?._id === driver._id && waitingForDriver ? (
                                            <>
                                              <FaClock className="mr-1" />
                                              Waiting...
                                            </>
                                          ) : assigning && selectedDriver?._id === driver._id ? (
                                            <>
                                              <FaSpinner className="mr-1 animate-spin" />
                                              Sending...
                                            </>
                                          ) : waitingForDriver || assignmentResult === 'accepted' ? (
                                            <>
                                              <FaClock className="mr-1" />
                                              Pending...
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
                                );
                              })}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              /* Normal Open Bookings List */
              <>
                <div className="flex justify-between items-center mb-4">
                  <p className="text-sm text-gray-600">
                    {openBookingsCount} booking{openBookingsCount !== 1 ? 's' : ''} waiting for driver assignment
                  </p>
                  <button
                    onClick={fetchOpenBookings}
                    disabled={loadingOpenBookings}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    <MdRefresh className={`text-lg ${loadingOpenBookings ? 'animate-spin' : ''}`} />
                    <span>Refresh</span>
                  </button>
                </div>

                {loadingOpenBookings ? (
                  <div className="flex flex-col items-center justify-center h-64 bg-white rounded-lg">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
                    <p className="text-gray-600">Loading open bookings...</p>
                  </div>
                ) : openBookings.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-64 bg-white rounded-lg">
                    <FaClipboardList className="text-6xl text-gray-300 mb-4" />
                    <p className="text-gray-600 text-lg font-medium">No open bookings</p>
                    <p className="text-gray-500 text-sm mt-2">
                      New bookings from Manual Booking will appear here
                    </p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {openBookings.map(booking => (
                      <OpenBookingCard
                        key={booking._id || booking.bookingId}
                        booking={booking}
                        onAssign={openDriverAssignment}
                        onCancel={cancelBooking}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Tab Content: Assigned Rides - Original content */}
        {activeTab === 'assigned' && (
          <>
            {/* Search and Filters */}
            <div className="flex flex-col md:flex-row gap-3 mb-4">
              {/* Search Bar */}
              <div className="flex-1 relative">
                <FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by passenger, driver, phone, or booking ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
              </div>

              {/* Source Filter */}
              <div className="relative">
                <FaFilter className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 pointer-events-none" />
                <select
                  value={filterSource}
                  onChange={(e) => setFilterSource(e.target.value)}
                  className="pl-10 pr-8 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none bg-white"
                >
                  <option value="all">All Sources</option>
                  <option value="manual">Manual Bookings</option>
                  <option value="app">App Bookings</option>
                </select>
              </div>

              {/* Status Filter */}
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none bg-white"
              >
                <option value="all">All Statuses</option>
                <option value="driver_assigned">Assigned</option>
                <option value="ride_started">In Progress</option>
                <option value="ride_ended">Arrived</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>

              {/* Refresh Button */}
              <button
                onClick={fetchRides}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                <MdRefresh className={`text-lg ${loading ? 'animate-spin' : ''}`} />
                <span>Refresh</span>
              </button>
            </div>

            {/* Last Update Time */}
            {lastUpdate && (
              <div className="mb-4 text-xs text-gray-500">
                Last updated: {lastUpdate.toLocaleTimeString()}
              </div>
            )}
          </>
        )}
      </div>

      {/* Stats Cards - Only show for Assigned tab */}
      {activeTab === 'assigned' && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 mb-6">
          {/* Total Active */}
          <div className="bg-white p-4 rounded-lg border border-gray-200">
            <p className="text-sm text-gray-600">Total</p>
            <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
          </div>

          {/* Assigned */}
          <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
            <p className="text-sm text-blue-600">Assigned</p>
            <p className="text-2xl font-bold text-blue-900">{stats.assigned}</p>
          </div>

          {/* In Progress */}
          <div className="bg-green-50 p-4 rounded-lg border border-green-200">
            <p className="text-sm text-green-600">In Progress</p>
            <p className="text-2xl font-bold text-green-900">{stats.inProgress}</p>
          </div>

          {/* Arrived */}
          <div className="bg-purple-50 p-4 rounded-lg border border-purple-200">
            <p className="text-sm text-purple-600">Arrived</p>
            <p className="text-2xl font-bold text-purple-900">{stats.arrived}</p>
          </div>

          {/* Completed */}
          <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
            <p className="text-sm text-gray-600">Completed</p>
            <p className="text-2xl font-bold text-gray-900">{stats.completed}</p>
          </div>

          {/* Cancelled */}
          <div className="bg-red-50 p-4 rounded-lg border border-red-200">
            <p className="text-sm text-red-600">Cancelled</p>
            <p className="text-2xl font-bold text-red-900">{stats.cancelled}</p>
          </div>

          {/* Manual */}
          <div className="bg-indigo-50 p-4 rounded-lg border border-indigo-200">
            <p className="text-sm text-indigo-600">Manual</p>
            <p className="text-2xl font-bold text-indigo-900">{stats.manual}</p>
          </div>

          {/* App */}
          <div className="bg-teal-50 p-4 rounded-lg border border-teal-200">
            <p className="text-sm text-teal-600">App</p>
            <p className="text-2xl font-bold text-teal-900">{stats.app}</p>
          </div>
        </div>
      )}

      {/* Rides Grid - Only show for Assigned tab */}
      {activeTab === 'assigned' && (loading ? (
        <div className="flex flex-col items-center justify-center h-64 bg-white rounded-lg">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <p className="text-gray-600">Loading rides...</p>
        </div>
      ) : filteredRides.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-64 bg-white rounded-lg">
          <FaClipboardList className="text-6xl text-gray-300 mb-4" />
          <p className="text-gray-600 text-lg font-medium">No rides found</p>
          <p className="text-gray-500 text-sm mt-2">
            {searchQuery || filterSource !== 'all' || filterStatus !== 'all'
              ? 'Try adjusting your filters or search query'
              : 'No rides in the last 24 hours. Click Refresh to check for new rides.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredRides.map((ride) => (
            <RideCard key={ride._id || ride.rideId} ride={ride} />
          ))}
        </div>
      ))}
    </div>
  );
};

export default FleetManager;
