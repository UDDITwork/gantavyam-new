import React from 'react';
import { useAdmin } from '../../contexts/AdminContext';

const Welcome = () => {
  const { admin } = useAdmin();

  const getRoleDisplayName = (role) => {
    switch(role) {
      case 'super-admin': return 'Super Admin';
      case 'admin': return 'Admin';
      case 'executive-manager': return 'Executive Manager';
      case 'fleet-manager': return 'Fleet Manager';
      default: return 'Admin';
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-gray-800 mb-4">
          Welcome, {admin?.name || 'Admin'}!
        </h1>
        <p className="text-lg text-gray-600">
          You are logged in as <span className="font-semibold text-blue-600">{getRoleDisplayName(admin?.role)}</span>
        </p>
        <p className="text-gray-500 mt-4">
          Select an option from the sidebar to get started.
        </p>
      </div>
    </div>
  );
};

export default Welcome;
