import React from 'react';
import { useNavigate } from 'react-router-dom';
import { FaUser, FaSignOutAlt, FaShieldAlt, FaClock } from 'react-icons/fa';
import { useAdmin } from '../../contexts/AdminContext';

const Settings = () => {
  const navigate = useNavigate();
  const { admin, clearAdmin, getRoleDisplayName } = useAdmin();

  const handleLogout = () => {
    clearAdmin();
    navigate('/admin/login');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h1 className="text-2xl font-bold text-gray-800">Settings</h1>
        <p className="text-gray-600 mt-1">Manage your account and preferences</p>
      </div>

      {/* Profile Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <FaUser className="text-blue-600" />
          Profile Information
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-sm text-gray-500">Name</label>
            <p className="text-gray-800 font-medium">{admin?.name || 'N/A'}</p>
          </div>
          <div>
            <label className="text-sm text-gray-500">Email</label>
            <p className="text-gray-800 font-medium">{admin?.email || 'N/A'}</p>
          </div>
          <div>
            <label className="text-sm text-gray-500">Role</label>
            <p className="text-gray-800 font-medium">{getRoleDisplayName()}</p>
          </div>
          <div>
            <label className="text-sm text-gray-500">Status</label>
            <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
              Active
            </span>
          </div>
        </div>
      </div>

      {/* Session Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <FaClock className="text-purple-600" />
          Session
        </h2>
        <p className="text-gray-600 text-sm mb-4">
          You are currently logged in. Click the button below to end your session.
        </p>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
        >
          <FaSignOutAlt />
          Logout
        </button>
      </div>

      {/* Security Info */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-4 flex items-center gap-2">
          <FaShieldAlt className="text-green-600" />
          Security
        </h2>
        <div className="text-sm text-gray-600 space-y-1">
          <p>• Your session is secured with JWT authentication</p>
          <p>• Token expires automatically for security</p>
          <p>• Always logout when using shared computers</p>
        </div>
      </div>
    </div>
  );
};

export default Settings;
