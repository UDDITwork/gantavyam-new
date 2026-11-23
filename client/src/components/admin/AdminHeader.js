import React, { useState, useEffect, useRef } from 'react';
import { FaSearch, FaBell, FaUserCircle, FaChevronDown, FaSignOutAlt, FaCog, FaCar, FaUser, FaCheck, FaTimes, FaMapMarkerAlt } from 'react-icons/fa';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAdmin } from '../../contexts/AdminContext';
import { getSocket } from '../../services/socket';
import { loginPathAfterSessionEnds } from '../../config/executiveLogin';

const AdminHeader = () => {
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const { admin, clearAdmin, getRoleDisplayName, isExecutive, assignedPod } = useAdmin();

  // Notification state (Admin Only)
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationRef = useRef(null);

  // Check if user is admin (for notification bell visibility)
  const isAdmin = admin?.role === 'admin' || admin?.role === 'super-admin';

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (notificationRef.current && !notificationRef.current.contains(event.target)) {
        setShowNotifications(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Socket listeners for notifications (Admin Only)
  useEffect(() => {
    if (!isAdmin) return;

    const socket = getSocket();
    if (!socket) return;

    console.log('[AdminHeader] Setting up notification listeners');

    // Listen for ride updates
    const handleRideUpdate = (data) => {
      addNotification({
        type: 'ride',
        title: getRideNotificationTitle(data),
        message: getRideNotificationMessage(data),
        data: data
      });
    };

    // Listen for driver online requests
    const handleOnlineRequest = (data) => {
      addNotification({
        type: 'driver_online',
        title: 'Driver Online Request',
        message: `${data.request?.driverName || 'A driver'} wants to go online`,
        data: data
      });
    };

    // Listen for driver offline requests
    const handleOfflineRequest = (data) => {
      addNotification({
        type: 'driver_offline',
        title: 'Driver Offline Request',
        message: `${data.request?.driverName || 'A driver'} wants to go offline`,
        data: data
      });
    };

    // Listen for new bookings
    const handleNewBooking = (data) => {
      addNotification({
        type: 'booking',
        title: 'New Booking',
        message: `New booking from ${data.pickupLocation?.boothName || 'Unknown'}`,
        data: data
      });
    };

    socket.on('rideUpdate', handleRideUpdate);
    socket.on('newOnlineRequest', handleOnlineRequest);
    socket.on('newOfflineRequest', handleOfflineRequest);
    socket.on('newOpenBooking', handleNewBooking);
    socket.on('newRideRequest', handleNewBooking);

    return () => {
      socket.off('rideUpdate', handleRideUpdate);
      socket.off('newOnlineRequest', handleOnlineRequest);
      socket.off('newOfflineRequest', handleOfflineRequest);
      socket.off('newOpenBooking', handleNewBooking);
      socket.off('newRideRequest', handleNewBooking);
    };
  }, [isAdmin]);

  const getRideNotificationTitle = (data) => {
    const status = data.status || data.type;
    switch (status) {
      case 'completed': return 'Ride Completed';
      case 'cancelled':
      case 'cancelled_by_admin':
      case 'cancelled_by_fm': return 'Ride Cancelled';
      case 'driver_assigned': return 'Driver Assigned';
      case 'ride_started': return 'Ride Started';
      case 'accepted': return 'Ride Accepted';
      default: return 'Ride Update';
    }
  };

  const getRideNotificationMessage = (data) => {
    const pickup = data.pickupLocation?.boothName || data.pickup || 'Unknown';
    const drop = data.destination || data.dropLocation?.address || data.drop || 'Unknown';
    return `${pickup} → ${drop}`;
  };

  const addNotification = (notification) => {
    const newNotification = {
      id: Date.now(),
      ...notification,
      time: new Date(),
      read: false
    };

    setNotifications(prev => [newNotification, ...prev].slice(0, 20)); // Keep last 20
    setUnreadCount(prev => prev + 1);
  };

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  const formatTimeAgo = (timestamp) => {
    if (!timestamp) return '';
    const now = new Date();
    const time = new Date(timestamp);
    const diffMs = now - time;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return 'Yesterday';
  };

  const getNotificationIcon = (type) => {
    switch (type) {
      case 'ride': return <FaCar className="text-blue-500" />;
      case 'driver_online': return <FaUser className="text-green-500" />;
      case 'driver_offline': return <FaUser className="text-red-500" />;
      case 'booking': return <FaCar className="text-purple-500" />;
      default: return <FaBell className="text-gray-500" />;
    }
  };

  const handleLogout = () => {
    clearAdmin();
    navigate(loginPathAfterSessionEnds());
  };

  const getPageTitle = () => {
    const path = location.pathname;
    if (path === '/admin' || path === '/admin/') return 'Welcome';
    if (path === '/admin/dashboard') return 'Dashboard';
    if (path === '/admin/add-user') return 'Add New User';
    if (path === '/admin/register-driver') return 'Register Driver';
    if (path === '/admin/drivers') return 'All Drivers';
    if (path === '/admin/view-users') return 'All Users';
    if (path.includes('/admin/users/')) return 'User Details';
    return 'Admin Panel';
  };

  const getBreadcrumbs = () => {
    const path = location.pathname;
    const segments = path.split('/').filter(Boolean);

    if (segments.length <= 1) return null;

    const breadcrumbs = segments.map((segment, index) => {
      const isLast = index === segments.length - 1;
      const href = '/' + segments.slice(0, index + 1).join('/');

      let title = segment;
      if (segment === 'admin') title = 'Admin';
      if (segment === 'add-user') title = 'Add User';
      if (segment === 'register-driver') title = 'Register Driver';
      if (segment === 'drivers') title = 'Drivers';
      if (segment === 'view-users') title = 'Users';
      if (segment === 'dashboard') title = 'Dashboard';

      return { title, href, isLast };
    });

    return breadcrumbs;
  };

  return (
    <header className="fixed top-0 left-64 right-0 h-16 bg-white shadow-sm border-b border-gray-200 flex items-center justify-between px-6 z-30">
      {/* Left side - Title and Breadcrumbs */}
      <div className="flex flex-col">
        <h1 className="text-xl font-semibold text-gray-800">{getPageTitle()}</h1>
        {getBreadcrumbs() && (
          <div className="flex items-center space-x-2 text-sm text-gray-500">
            {getBreadcrumbs().map((crumb, index) => (
              <React.Fragment key={index}>
                {index > 0 && <span>/</span>}
                {crumb.isLast ? (
                  <span className="text-blue-600">{crumb.title}</span>
                ) : (
                  <button
                    onClick={() => navigate(crumb.href)}
                    className="hover:text-blue-600 transition-colors"
                  >
                    {crumb.title}
                  </button>
                )}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Right side - Search, Notifications, Profile */}
      <div className="flex items-center space-x-4">
        {/* Pickup point badge - executives only */}
        {isExecutive && (
          <span
            title={assignedPod ? `Pickup point: ${assignedPod.displayName || assignedPod.name}` : 'No pickup point assigned yet'}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border whitespace-nowrap ${
              assignedPod ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}
          >
            <FaMapMarkerAlt className="h-3 w-3" />
            {assignedPod ? (assignedPod.shortName || assignedPod.displayName || assignedPod.name) : 'No pickup point'}
          </span>
        )}

        {/* Search */}
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <FaSearch className="h-4 w-4 text-gray-400" />
          </div>
          <input
            type="text"
            placeholder="Search users, drivers..."
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            className="w-80 pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>

        {/* Notifications - Admin Only */}
        {isAdmin && (
          <div className="relative" ref={notificationRef}>
            <button
              onClick={() => setShowNotifications(!showNotifications)}
              className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors relative"
            >
              <FaBell className="h-5 w-5" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 h-5 w-5 bg-red-500 rounded-full flex items-center justify-center text-xs text-white font-medium">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* Notification Dropdown */}
            {showNotifications && (
              <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-gray-200 z-50 overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                  <h3 className="font-semibold text-gray-800">Notifications</h3>
                  {unreadCount > 0 && (
                    <button
                      onClick={markAllRead}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Mark all read
                    </button>
                  )}
                </div>

                {/* Notification List */}
                <div className="max-h-96 overflow-y-auto">
                  {notifications.length > 0 ? (
                    notifications.map((notification) => (
                      <div
                        key={notification.id}
                        className={`px-4 py-3 border-b border-gray-100 hover:bg-gray-50 cursor-pointer ${
                          !notification.read ? 'bg-blue-50' : ''
                        }`}
                      >
                        <div className="flex items-start space-x-3">
                          <div className="flex-shrink-0 mt-1">
                            {getNotificationIcon(notification.type)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-900">
                              {notification.title}
                            </p>
                            <p className="text-xs text-gray-500 truncate">
                              {notification.message}
                            </p>
                            <p className="text-xs text-gray-400 mt-1">
                              {formatTimeAgo(notification.time)}
                            </p>
                          </div>
                          {!notification.read && (
                            <div className="w-2 h-2 bg-blue-500 rounded-full flex-shrink-0 mt-2"></div>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="px-4 py-8 text-center text-gray-500">
                      <FaBell className="mx-auto text-3xl text-gray-300 mb-2" />
                      <p className="text-sm">No notifications yet</p>
                    </div>
                  )}
                </div>

                {/* Footer */}
                {notifications.length > 0 && (
                  <div className="px-4 py-2 bg-gray-50 border-t border-gray-200">
                    <button
                      onClick={() => {
                        setShowNotifications(false);
                        navigate('/admin/ride-management');
                      }}
                      className="text-sm text-blue-600 hover:text-blue-800 w-full text-center"
                    >
                      View All Activity
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Profile Dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowUserDropdown(!showUserDropdown)}
            className="flex items-center space-x-3 text-gray-700 hover:text-gray-900 focus:outline-none"
          >
            <div className="flex items-center space-x-2">
              <FaUserCircle className="h-8 w-8 text-blue-600" />
              <div className="text-left">
                <p className="text-sm font-medium">{admin?.name || 'Admin'}</p>
                <p className="text-xs text-gray-500">{getRoleDisplayName()}</p>
              </div>
            </div>
            <FaChevronDown className={`h-4 w-4 transition-transform ${showUserDropdown ? 'transform rotate-180' : ''}`} />
          </button>

          {showUserDropdown && (
            <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
              <button
                onClick={() => {
                  setShowUserDropdown(false);
                  // Add settings navigation here
                }}
                className="flex items-center space-x-2 w-full px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors"
              >
                <FaCog className="h-4 w-4" />
                <span>Settings</span>
              </button>
              <hr className="my-1" />
              <button
                onClick={handleLogout}
                className="flex items-center space-x-2 w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
              >
                <FaSignOutAlt className="h-4 w-4" />
                <span>Logout</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

export default AdminHeader;
