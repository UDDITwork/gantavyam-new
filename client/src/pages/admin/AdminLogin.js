import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { adminLogin } from '../../services/api';
import { clearTokensForType } from '../../services/tokenService';
import { API_URL } from '../../config';
import { useAdmin } from '../../contexts/AdminContext';
import { getPodByKey } from '../../config/pickupPods';
import { executiveLoginPath, forgetExecutiveLogin, rememberedExecutiveLogin } from '../../config/executiveLogin';

const AdminLogin = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [executivePath, setExecutivePath] = useState(null); // where an executive who tried to log in here belongs
  const navigate = useNavigate();
  const location = useLocation();
  const { updateAdmin } = useAdmin();

  // This is the admin login. A browser where an executive logged in goes on to that executive's own login page
  // (after logging out, or when the session has run out); "?portal=admin" is the way to the admin login from there.
  useEffect(() => {
    if (new URLSearchParams(location.search).get('portal') === 'admin') {
      forgetExecutiveLogin();
      return;
    }
    const executiveLogin = rememberedExecutiveLogin();
    if (executiveLogin) navigate(executiveLogin, { replace: true });
  }, [location.search, navigate]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setExecutivePath(null);
    try {
      console.log('🔐 [Admin Login] Attempting login with:', { email });
      console.log('🔐 [Admin Login] Using API URL:', API_URL);
      
      // Test connectivity first using the proper API URL
      try {
        const testResponse = await fetch(`${API_URL}/auth/admin/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test', password: 'test' })
        });
        console.log('🔐 [Admin Login] Connectivity test:', testResponse.status);
      } catch (connectError) {
        console.error('🔐 [Admin Login] Connectivity test failed:', connectError);
        console.log('🔐 [Admin Login] Failed API URL was:', API_URL);
        setError(`Cannot connect to server at ${API_URL}. Please check your internet connection.`);
        return;
      }
      
      const response = await adminLogin({ email, password });
      console.log('🔐 [Admin Login] Login response:', response);

      if (response.success && response.token && response.admin) {
        console.log('🔐 [Admin Login] Login successful');
        console.log('🔐 [Admin Login] Admin role:', response.admin.role);
        console.log('🔐 [Admin Login] Admin permissions:', response.admin.permissions);

        // Executives (sub-admins of one pickup point) have their own login pages
        if (response.admin.role === 'executive-manager') {
          clearTokensForType('admin'); // nothing stays stored: the server accepted the login, this page does not
          setError('This is the admin login. Executives please use your own login page.');
          setExecutivePath(executiveLoginPath(getPodByKey(response.admin.assignedPickupLocation)));
          return;
        }

        // Update admin context with user data
        updateAdmin(response.admin);
        forgetExecutiveLogin();

        console.log('🔐 [Admin Login] Token stored:', !!localStorage.getItem('adminToken'));
        navigate('/admin');
      } else {
        console.error('🔐 [Admin Login] Login failed - no token in response:', response);
        setError('Login failed.');
      }
    } catch (err) {
      console.error('🔐 [Admin Login] Login error:', err);
      setError(err.error || err.message || 'Login failed.');
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 py-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8 mb-4">
        <h2 className="text-2xl font-bold text-blue-700 mb-6 text-center">Admin Login</h2>
        {error && (
          <div className="bg-red-100 text-red-700 px-4 py-2 rounded mb-4 border-l-4 border-red-500">
            <p>{error}</p>
            {executivePath && (
              <Link to={executivePath} className="inline-block mt-1 font-medium underline">Go to the executive login</Link>
            )}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="email" className="block text-gray-700 font-medium mb-1">Email</label>
            <input type="email" id="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <div>
            <label htmlFor="password" className="block text-gray-700 font-medium mb-1">Password</label>
            <input type="password" id="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-400" />
          </div>
          <button type="submit" className="w-full bg-blue-600 text-white font-semibold py-2 rounded hover:bg-blue-800 transition">Login</button>
        </form>
      </div>
      <div className="text-center text-gray-500 text-xs mt-2">&copy; 2025 GANTAVYAM. All rights reserved.</div>
    </div>
  );
};

export default AdminLogin; 