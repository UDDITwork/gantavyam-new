import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { adminLogin } from '../../services/api';
import { clearTokensForType } from '../../services/tokenService';
import { useAdmin } from '../../contexts/AdminContext';
import { getPodByKey } from '../../config/pickupPods';
import { executiveLoginPath, podForSlug, rememberExecutiveLogin } from '../../config/executiveLogin';

// One accent per pickup point, the same colours as the pickup point badges in the admin panel
const ACCENTS = {
  HK: { title: 'text-indigo-700', pill: 'bg-indigo-50 text-indigo-700 border-indigo-200', button: 'bg-indigo-600 hover:bg-indigo-800', ring: 'focus:ring-indigo-400' },
  PC: { title: 'text-teal-700', pill: 'bg-teal-50 text-teal-700 border-teal-200', button: 'bg-teal-600 hover:bg-teal-800', ring: 'focus:ring-teal-400' },
  DEFAULT: { title: 'text-blue-700', pill: 'bg-blue-50 text-blue-700 border-blue-200', button: 'bg-blue-600 hover:bg-blue-800', ring: 'focus:ring-blue-400' }
};

// Login page for executives (sub-admins of one pickup point). With a pickup point in the address
// (/executive/hauz-khas/login) only that pickup point's executive can log in here.
const ExecutiveLogin = () => {
  const { podSlug } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { updateAdmin, isExecutive } = useAdmin();

  const pod = podForSlug(podSlug);
  const accent = ACCENTS[pod ? pod.key : 'DEFAULT'];

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState(null); // { path, label }: where this account should log in instead
  const [submitting, setSubmitting] = useState(false);

  // Moving to another pickup point's login page (the link in an error message) starts with a clean page
  useEffect(() => {
    setError('');
    setHint(null);
  }, [podSlug]);

  // An executive who is already logged in goes straight to their screens
  useEffect(() => {
    if (isExecutive) navigate('/admin/manual-booking', { replace: true });
  }, [isExecutive, navigate]);

  // An address with a pickup point that does not exist falls back to the common executive login
  if (podSlug && !pod) return <Navigate to="/executive/login" replace />;

  const reject = (message, nextHint = null) => {
    clearTokensForType('admin'); // the server accepted the login, this page does not: nothing stays stored
    setError(message);
    setHint(nextHint);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setHint(null);
    setSubmitting(true);
    try {
      const response = await adminLogin({ email: email.trim(), password });
      if (!(response.success && response.token && response.admin)) {
        setError('Login failed.');
        return;
      }

      const account = response.admin;
      if (account.role !== 'executive-manager') {
        reject('This is the executive login page. Admins please use the admin login page.', { path: '/admin/login?portal=admin', label: 'Go to the admin login' });
        return;
      }

      const ownPod = getPodByKey(account.assignedPickupLocation);
      if (pod && (!ownPod || ownPod.key !== pod.key)) {
        reject(
          ownPod
            ? `This account belongs to ${ownPod.shortName}. Please log in on the ${ownPod.shortName} executive login page.`
            : 'This account is not linked to a pickup point yet. Please ask the admin to set it.',
          ownPod ? { path: executiveLoginPath(ownPod), label: `Go to the ${ownPod.shortName} login` } : null
        );
        return;
      }

      updateAdmin(account);
      rememberExecutiveLogin(location.pathname);
      navigate('/admin/manual-booking');
    } catch (err) {
      setError((err && (err.error || err.message)) || 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = `w-full px-4 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 ${accent.ring}`;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 py-8">
      <div className="w-full max-w-md bg-white rounded-lg shadow-lg p-8 mb-4">
        <h2 className={`text-2xl font-bold ${accent.title} mb-2 text-center`}>Executive Login</h2>
        <div className="flex justify-center mb-6">
          <span className={`inline-block px-3 py-1 text-sm font-medium rounded-full border ${accent.pill}`}>
            {pod ? pod.displayName : 'Pickup point executives'}
          </span>
        </div>

        {error && (
          <div role="alert" className="bg-red-100 text-red-700 px-4 py-2 rounded mb-4 border-l-4 border-red-500">
            <p>{error}</p>
            {hint && (
              <Link to={hint.path} className="inline-block mt-1 font-medium underline">
                {hint.label}
              </Link>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="email" className="block text-gray-700 font-medium mb-1">Email</label>
            <input type="email" id="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" className={inputClass} />
          </div>
          <div>
            <label htmlFor="password" className="block text-gray-700 font-medium mb-1">Password</label>
            <input type="password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" className={inputClass} />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className={`w-full text-white font-semibold py-2 rounded transition disabled:opacity-60 ${accent.button}`}
          >
            {submitting ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>

      <div className="text-center text-gray-500 text-sm">
        Admin? <Link to="/admin/login?portal=admin" className="text-blue-600 underline">Log in here</Link>
      </div>
      <div className="text-center text-gray-500 text-xs mt-2">&copy; 2025 GANTAVYAM. All rights reserved.</div>
    </div>
  );
};

export default ExecutiveLogin;
