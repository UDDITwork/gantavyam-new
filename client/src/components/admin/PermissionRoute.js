import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAdmin } from '../../contexts/AdminContext';

/**
 * PermissionRoute - A route wrapper that checks if the user has the required permission and/or role
 *
 * @param {React.ReactNode} children - The component to render if permission is granted
 * @param {string} requiredPermission - The permission required to access this route (optional)
 * @param {string|string[]} requiredRole - The role(s) required to access this route (optional)
 * @param {string} fallback - The path to redirect to if permission is denied (default: '/admin')
 *
 * @example
 * // Permission only
 * <PermissionRoute requiredPermission={PERMISSIONS.FARE_VIEW}>
 *   <FareManagement />
 * </PermissionRoute>
 *
 * @example
 * // Role only
 * <PermissionRoute requiredRole={['admin', 'super-admin']}>
 *   <AdminDashboard />
 * </PermissionRoute>
 *
 * @example
 * // Both permission and role
 * <PermissionRoute requiredPermission={PERMISSIONS.FINANCIAL_VIEW} requiredRole="admin">
 *   <AdminDashboard />
 * </PermissionRoute>
 */
const PermissionRoute = ({ children, requiredPermission, requiredRole, fallback = '/admin' }) => {
  const { hasPermission, admin, loading } = useAdmin();

  // Show loading state while admin data is being loaded
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

  // If no admin, redirect to fallback
  if (!admin) {
    console.warn(`Access denied: No admin logged in. Redirecting to ${fallback}`);
    return <Navigate to={fallback} replace />;
  }

  // Check role if specified
  if (requiredRole) {
    const allowedRoles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    const userRole = admin?.role;
    
    // Check if user's role is in the allowed roles list
    if (!allowedRoles.includes(userRole)) {
      console.warn(`Access denied: User role "${userRole}" not in allowed roles [${allowedRoles.join(', ')}]. Redirecting to ${fallback}`);
      return <Navigate to={fallback} replace />;
    }
  }

  // Check permission if specified
  if (requiredPermission && !hasPermission(requiredPermission)) {
    console.warn(`Access denied: User lacks permission "${requiredPermission}". Redirecting to ${fallback}`);
    return <Navigate to={fallback} replace />;
  }

  // All checks passed, render the component
  return children;
};

export default PermissionRoute;
