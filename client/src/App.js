// client/src/App.js
import React from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LoadScript } from '@react-google-maps/api';
import LandingPage from './pages/LandingPage';
// Initialize app startup procedures (removed automatic import to prevent driver logout)
// State Management
import { DriverStateProvider } from './contexts/DriverStateContext';
import { AdminProvider, PERMISSIONS, EXECUTIVE_PAGES, useAdmin } from './contexts/AdminContext';
// Admin
import AdminLayout from './components/admin/AdminLayout';
import ProtectedAdminRoute from './components/admin/ProtectedAdminRoute';
import PermissionRoute from './components/admin/PermissionRoute';
import AdminDashboard from './pages/admin/Dashboard';
import AddUser from './pages/admin/AddUser';
import ViewUsers from './pages/admin/ViewUsers';
import ViewUserDetails from './pages/admin/ViewUserDetails';
import AddDriver from './pages/admin/AddDriver';
import AdminLogin from './pages/admin/AdminLogin';
import AllDrivers from './pages/admin/AllDrivers';
import RideManagement from './pages/admin/RideManagement';
import QueueManagement from './pages/admin/QueueManagement';
import BoothManagement from './pages/admin/BoothManagement';
import ManualBooking from './pages/admin/ManualBooking';
import FareManagement from './pages/admin/FareManagement';
import FleetManager from './pages/admin/FleetManager';
import Welcome from './pages/admin/Welcome';
import Settings from './pages/admin/Settings';
import Executives from './pages/admin/Executives';
// Driver
import ModernDriverDashboard from './components/driver/minimal/ModernDriverDashboard';
import DriverLogin from './pages/driver/Login';
import DriverSignup from './pages/driver/Signup';
import DriverProfile from './pages/driver/Profile';
import PendingApproval from './pages/driver/PendingApproval';
// User
import UserDashboard from './pages/user/Dashboard';
import NewUserDashboard from './pages/user/NewDashboard';
import UserLogin from './pages/user/Login';
import UserSignup from './pages/user/Signup';
import ForgotPassword from './pages/user/ForgotPassword';
// Test Pages
import UserBooking from './pages/test/UserBooking';
import DriverView from './pages/test/DriverView';

// Move these OUTSIDE the component to prevent recreation on each render
const GOOGLE_MAPS_API_KEY = process.env.REACT_APP_GOOGLE_MAPS_API_KEY;
const libraries = ["places", "geometry", "routes"]; // Static array prevents LoadScript reload warnings

// Executives (sub-admins of ONE pickup point) may only open the screens in EXECUTIVE_PAGES. Anything else under
// /admin (dashboard, rides, users, fares, settings, executives, ...) sends them to the first of those they may
// use, which is Manual Booking. The server refuses everything else as well; this keeps the pages out of sight.
const ExecutiveRouteGuard = ({ children }) => {
  const { loading, isExecutive, hasPermission, clearAdmin } = useAdmin();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Every other role is untouched
  if (!isExecutive) return children;

  const path = pathname.toLowerCase().replace(/\/+$/, '');
  if (EXECUTIVE_PAGES.some((page) => path === page.path || path.startsWith(`${page.path}/`))) return children;

  const home = EXECUTIVE_PAGES.find((page) => hasPermission(page.permission));
  if (home) return <Navigate to={home.path} replace />;

  // An executive without any of the four permissions has nowhere to go (redirecting would loop)
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
      <div className="max-w-md w-full bg-white rounded-lg shadow p-8 text-center">
        <h2 className="text-xl font-semibold text-gray-800 mb-2">No screens available</h2>
        <p className="text-gray-600 mb-6">
          Your account cannot use any admin screen yet. Please ask the admin to check your access.
        </p>
        <button
          onClick={() => { clearAdmin(); navigate('/admin/login'); }}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
        >
          Log out
        </button>
      </div>
    </div>
  );
};

function App() {
  return (
    <AdminProvider>
      <LoadScript googleMapsApiKey={GOOGLE_MAPS_API_KEY} libraries={libraries} >
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/admin/login" element={<AdminLogin />} />
          <Route path="/admin" element={
            <ProtectedAdminRoute>
              <ExecutiveRouteGuard>
                <AdminLayout />
              </ExecutiveRouteGuard>
            </ProtectedAdminRoute>
          }>
            <Route index element={<Welcome />} />
            <Route path="dashboard" element={
              <PermissionRoute requiredPermission={PERMISSIONS.FINANCIAL_VIEW} requiredRole={['admin', 'super-admin']}>
                <AdminDashboard />
              </PermissionRoute>
            } />
            <Route path="register-driver" element={
              <PermissionRoute requiredPermission={PERMISSIONS.DRIVERS_CREATE}>
                <AddDriver />
              </PermissionRoute>
            } />
            <Route path="add-user" element={
              <PermissionRoute requiredPermission={PERMISSIONS.USERS_CREATE}>
                <AddUser />
              </PermissionRoute>
            } />
            <Route path="drivers" element={<AllDrivers />} />
            <Route path="view-users" element={<ViewUsers />} />
            <Route path="rides" element={<RideManagement />} />
            <Route path="manual-booking" element={
              <PermissionRoute requiredPermission={PERMISSIONS.RIDES_MANUAL_BOOKING}>
                <ManualBooking />
              </PermissionRoute>
            } />
            <Route path="fleet-manager" element={
              <PermissionRoute requiredPermission={PERMISSIONS.RIDES_VIEW}>
                <FleetManager />
              </PermissionRoute>
            } />
            <Route path="queue" element={<QueueManagement />} />
            <Route path="booths" element={<BoothManagement />} />
            <Route path="fare-management" element={
              <PermissionRoute requiredPermission={PERMISSIONS.FARE_VIEW}>
                <FareManagement />
              </PermissionRoute>
            } />
            <Route path="settings" element={
              <PermissionRoute requiredPermission={PERMISSIONS.SETTINGS_VIEW}>
                <Settings />
              </PermissionRoute>
            } />
            <Route path="executives" element={
              <PermissionRoute requiredPermission={PERMISSIONS.ADMINS_MANAGE}>
                <Executives />
              </PermissionRoute>
            } />
          </Route>
          <Route path="/admin/users/:id" element={
            <ProtectedAdminRoute>
              <ExecutiveRouteGuard>
                <ViewUserDetails />
              </ExecutiveRouteGuard>
            </ProtectedAdminRoute>
          } />
          <Route path="/admin/drivers" element={
            <ProtectedAdminRoute>
              <ExecutiveRouteGuard>
                <AllDrivers />
              </ExecutiveRouteGuard>
            </ProtectedAdminRoute>
          } />
          {/* Any other /admin/... address: executives go to their home screen, everybody else sees what they saw before (nothing) */}
          <Route path="/admin/*" element={<ExecutiveRouteGuard>{null}</ExecutiveRouteGuard>} />
          <Route path="/driver/signup" element={<DriverSignup />} />
          <Route path="/driver/login" element={<DriverLogin />} />
          <Route path="/user/signup" element={<UserSignup />} />
          <Route path="/user/login" element={<UserLogin />} />
          <Route path="/user/dashboard" element={<NewUserDashboard />} />
          <Route path="/user/dashboard-old" element={<UserDashboard />} />
          <Route path="/driver/dashboard" element={
            <DriverStateProvider>
              <ModernDriverDashboard />
            </DriverStateProvider>
          } />
          <Route path="/driver/minimal" element={
            <DriverStateProvider>
              <ModernDriverDashboard />
            </DriverStateProvider>
          } />
          <Route path="/driver/profile/:id" element={<DriverProfile />} />
          <Route path="/user/forgot-password" element={<ForgotPassword />} />
          <Route path="/driver/pending" element={<PendingApproval />} />
          {/* Test Routes */}
          <Route path="/test/user" element={<UserBooking />} />
          <Route path="/test/driver" element={<DriverView />} />
        </Routes>
      </LoadScript>
    </AdminProvider>
  );
}

export default App;