import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import toast, { Toaster } from 'react-hot-toast';
import {
  FiUsers, FiPlus, FiEdit2, FiTrash2, FiEye, FiEyeOff, FiRefreshCw, FiCopy,
  FiMapPin, FiInfo, FiAlertCircle, FiX, FiCheckCircle
} from 'react-icons/fi';
import ModernCard from '../../components/admin/ModernCard';
import { admin as adminAPI } from '../../services/api';
import { PICKUP_PODS, getPodByKey } from '../../config/pickupPods';

const MIN_PASSWORD_LENGTH = 8;
const GENERATED_PASSWORD_LENGTH = 14;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Characters that cannot be mixed up when a password is read out or retyped (no 0/O, 1/l/I)
const PASSWORD_CHARACTER_SETS = [
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnpqrstuvwxyz',
  '23456789',
  '!@#$%&*?'
];

// A random integer in [0, max) from the browser's secure generator, without modulo bias
const randomInt = (max) => {
  const cryptoApi = window.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure random numbers are not available in this browser');
  }
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do {
    cryptoApi.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % max;
};

// One character of every kind first, the rest from all kinds, then shuffled
const generatePassword = (length = GENERATED_PASSWORD_LENGTH) => {
  const everything = PASSWORD_CHARACTER_SETS.join('');
  const chars = PASSWORD_CHARACTER_SETS.map((set) => set[randomInt(set.length)]);
  while (chars.length < length) {
    chars.push(everything[randomInt(everything.length)]);
  }
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
};

// Clipboard API where available (HTTPS / localhost), old copy command otherwise
const copyText = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the old way
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(area);
    return copied;
  } catch {
    return false;
  }
};

const errorMessage = (err, fallback) => {
  const message = err && (err.error || err.message);
  return typeof message === 'string' && message ? message : fallback;
};

const toDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

// "22 Nov 2026"
const formatDate = (value) => {
  const date = toDate(value);
  return date ? date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : null;
};

// "03:30 pm"
const formatTime = (value) => {
  const date = toDate(value);
  return date ? date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : null;
};

// "22 Nov 2026, 03:30 pm"
const formatDateTime = (value) => {
  const date = formatDate(value);
  return date ? `${date}, ${formatTime(value)}` : null;
};

const initialsOf = (name) => {
  const letters = String(name || '').trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('');
  return (letters || '?').toUpperCase();
};

// The pod of an executive (the object the server sends, or looked up from the pod key)
const podOf = (executive) => (executive && (executive.pod || getPodByKey(executive.assignedPickupLocation))) || null;
const podKeyOf = (executive) => {
  const pod = podOf(executive);
  return pod ? pod.key : '';
};
const podTitle = (pod) => (pod ? pod.displayName || pod.name || pod.shortName || pod.key : '');

const POD_BADGE_STYLES = {
  HK: 'bg-blue-50 text-blue-700 border-blue-200',
  PC: 'bg-purple-50 text-purple-700 border-purple-200'
};

const PodBadge = ({ executive }) => {
  const pod = podOf(executive);
  if (!pod) {
    return (
      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border bg-amber-50 text-amber-700 border-amber-200">
        Not assigned
      </span>
    );
  }
  return (
    <span
      title={podTitle(pod)}
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium border ${POD_BADGE_STYLES[pod.key] || 'bg-gray-50 text-gray-700 border-gray-200'}`}
    >
      <FiMapPin className="h-3 w-3" />
      {pod.shortName || podTitle(pod)}
    </span>
  );
};

// Activate / deactivate toggle with its Active / Inactive label. The button is only the tap area (the global phone
// styles give every button a 44px minimum size), the pill inside is what is drawn.
const StatusSwitch = ({ executive, busy, onToggle }) => {
  const active = executive.isActive !== false;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={`${active ? 'Deactivate' : 'Activate'} ${executive.name}`}
        title={active ? 'Click to deactivate' : 'Click to activate'}
        disabled={busy}
        onClick={() => onToggle(executive)}
        className="group inline-flex items-center justify-center rounded-full focus:outline-none disabled:cursor-not-allowed"
      >
        <span
          className={`relative inline-block h-6 w-11 flex-shrink-0 rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-blue-500 group-focus-visible:ring-offset-2 ${
            active ? 'bg-green-500' : 'bg-gray-300'
          } ${busy ? 'opacity-50' : ''}`}
        >
          <span
            className={`absolute top-1 left-1 h-4 w-4 rounded-full bg-white shadow transition-transform ${
              active ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </span>
      </button>
      <span className={`text-xs font-medium ${active ? 'text-green-700' : 'text-gray-500'}`}>
        {active ? 'Active' : 'Inactive'}
      </span>
    </div>
  );
};

// Shared modal frame: Escape closes it (unless something is being saved). It is rendered straight into <body> so
// the admin layout (stacking, spacing, clipping) cannot affect the overlay.
const Modal = ({ title, icon, onClose, busy = false, maxWidth = 'sm:max-w-lg', children }) => {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`relative w-full ${maxWidth} max-h-[92vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl`}
      >
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-gray-100">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            {icon}
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="p-1 text-gray-400 hover:text-gray-700 disabled:opacity-50 transition-colors"
          >
            <FiX className="h-5 w-5" />
          </button>
        </div>
        <div className="px-5 sm:px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
};

const inputClass = (hasError) =>
  `w-full px-3 py-2 text-sm border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
    hasError ? 'border-red-400' : 'border-gray-300'
  }`;

// Add / edit form. After a new executive (or a new password) the login details stay on screen so the admin can
// copy them: the password is only ever known here and cannot be shown again once this window is closed.
const ExecutiveFormModal = ({ executive, pods, onClose, onSaved }) => {
  const isEdit = !!executive;
  const [form, setForm] = useState(() => ({
    name: executive ? executive.name || '' : '',
    email: executive ? executive.email || '' : '',
    password: '',
    assignedPickupLocation: podKeyOf(executive) || (pods.length === 1 ? pods[0].key : '')
  }));
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [credentials, setCredentials] = useState(null);
  const nameInput = useRef(null);

  useEffect(() => {
    if (nameInput.current) nameInput.current.focus();
  }, []);

  const requestClose = () => {
    if (!saving) onClose();
  };

  const setField = (field) => (event) => {
    const { value } = event.target;
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: '' } : prev));
    setServerError('');
  };

  const validate = () => {
    const next = {};
    if (!form.name.trim()) next.name = "Enter the executive's name";
    if (!form.email.trim()) next.email = 'Enter an e-mail address';
    else if (!EMAIL_PATTERN.test(form.email.trim())) next.email = 'Enter a valid e-mail address';
    if (!form.assignedPickupLocation) next.assignedPickupLocation = 'Choose a pickup point';
    if (!isEdit && !form.password) next.password = 'Set a password for the executive';
    else if (form.password && form.password.length < MIN_PASSWORD_LENGTH) {
      next.password = `The password needs at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    return next;
  };

  const handleGenerate = () => {
    try {
      const password = generatePassword();
      setForm((prev) => ({ ...prev, password }));
      setErrors((prev) => (prev.password ? { ...prev, password: '' } : prev));
      setServerError('');
      setShowPassword(true);
    } catch {
      toast.error('This browser cannot generate a secure password. Please type one instead.');
    }
  };

  const handleCopyPassword = async () => {
    if (!form.password) return;
    const copied = await copyText(form.password);
    if (copied) toast.success('Password copied');
    else toast.error('Could not copy. Select the password and copy it manually.');
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (saving) return;

    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;

    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    const podKey = form.assignedPickupLocation;

    let payload;
    if (isEdit) {
      // Only send what changed
      payload = {};
      if (name !== (executive.name || '')) payload.name = name;
      if (email !== String(executive.email || '').toLowerCase()) payload.email = email;
      if (podKey !== podKeyOf(executive)) payload.assignedPickupLocation = podKey;
      if (form.password) payload.password = form.password;
      if (Object.keys(payload).length === 0) {
        toast('Nothing to update');
        onClose();
        return;
      }
    } else {
      payload = { name, email, password: form.password, assignedPickupLocation: podKey };
    }

    setSaving(true);
    setServerError('');
    try {
      const response = isEdit
        ? await adminAPI.updateExecutive(executive._id, payload)
        : await adminAPI.createExecutive(payload);
      if (response && response.success === false) {
        throw new Error(response.error || response.message || 'The request failed');
      }
      onSaved(response ? response.data : null);

      if (!isEdit || payload.password) {
        toast.success(isEdit ? 'Executive updated, new password set' : 'Executive created');
        setCredentials({
          created: !isEdit,
          name,
          email,
          password: form.password,
          pod: podTitle(pods.find((pod) => pod.key === podKey) || getPodByKey(podKey))
        });
      } else {
        toast.success('Executive updated');
        onClose();
      }
    } catch (err) {
      const message = errorMessage(err, isEdit ? 'Could not update the executive' : 'Could not create the executive');
      setServerError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const loginUrl = `${window.location.origin}/admin/login`;

  const handleCopyLogin = async () => {
    if (!credentials) return;
    const text = [
      'Gantavyam admin panel login',
      `Login page: ${loginUrl}`,
      `E-mail: ${credentials.email}`,
      `Password: ${credentials.password}`,
      `Pickup point: ${credentials.pod}`
    ].join('\n');
    const copied = await copyText(text);
    if (copied) toast.success('Login details copied');
    else toast.error('Could not copy. Select the details and copy them manually.');
  };

  // Success view with the login details
  if (credentials) {
    return (
      <Modal
        title={credentials.created ? 'Executive created' : 'Password updated'}
        icon={<FiCheckCircle className="h-5 w-5 text-green-600" />}
        onClose={onClose}
      >
        <p className="text-sm text-gray-600">
          Share these login details with <span className="font-medium text-gray-900">{credentials.name}</span> in a safe way.
        </p>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-gray-500">Login page</dt>
            <dd className="font-medium text-gray-900 break-all">{loginUrl}</dd>
          </div>
          <div>
            <dt className="text-gray-500">E-mail</dt>
            <dd className="font-medium text-gray-900 break-all">{credentials.email}</dd>
          </div>
          <div>
            <dt className="text-gray-500">Password</dt>
            <dd>
              <code className="mt-1 block px-3 py-2 bg-gray-100 rounded-lg font-mono text-gray-900 break-all select-all">
                {credentials.password}
              </code>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Pickup point</dt>
            <dd className="font-medium text-gray-900">{credentials.pod}</dd>
          </div>
        </dl>
        <p className="mt-4 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
          Copy the password now. It cannot be shown again once you close this window.
        </p>
        <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
          <button
            type="button"
            onClick={handleCopyLogin}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <FiCopy className="h-4 w-4" />
            Copy login details
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={isEdit ? 'Edit executive' : 'Add executive'}
      icon={<FiUsers className="h-5 w-5 text-blue-600" />}
      onClose={requestClose}
      busy={saving}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {serverError && (
          <div role="alert" className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
            <FiAlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
            <span className="text-sm text-red-800">{serverError}</span>
          </div>
        )}

        <div>
          <label htmlFor="executive-name" className="block text-sm font-medium text-gray-700 mb-1">
            Name <span className="text-red-500">*</span>
          </label>
          <input
            id="executive-name"
            ref={nameInput}
            type="text"
            value={form.name}
            onChange={setField('name')}
            maxLength={100}
            autoComplete="off"
            aria-invalid={!!errors.name}
            className={inputClass(!!errors.name)}
            placeholder="Full name"
          />
          {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name}</p>}
        </div>

        <div>
          <label htmlFor="executive-email" className="block text-sm font-medium text-gray-700 mb-1">
            E-mail <span className="text-red-500">*</span>
          </label>
          <input
            id="executive-email"
            type="email"
            value={form.email}
            onChange={setField('email')}
            maxLength={254}
            autoComplete="off"
            aria-invalid={!!errors.email}
            className={inputClass(!!errors.email)}
            placeholder="name@example.com"
          />
          {errors.email ? (
            <p className="mt-1 text-xs text-red-600">{errors.email}</p>
          ) : (
            <p className="mt-1 text-xs text-gray-500">The executive logs in to the admin panel with this e-mail.</p>
          )}
        </div>

        <div>
          <label htmlFor="executive-pod" className="block text-sm font-medium text-gray-700 mb-1">
            Pickup point <span className="text-red-500">*</span>
          </label>
          <select
            id="executive-pod"
            value={form.assignedPickupLocation}
            onChange={setField('assignedPickupLocation')}
            aria-invalid={!!errors.assignedPickupLocation}
            className={inputClass(!!errors.assignedPickupLocation)}
          >
            <option value="">Select a pickup point</option>
            {pods.map((pod) => (
              <option key={pod.key} value={pod.key}>
                {podTitle(pod)}
              </option>
            ))}
          </select>
          {errors.assignedPickupLocation ? (
            <p className="mt-1 text-xs text-red-600">{errors.assignedPickupLocation}</p>
          ) : (
            <p className="mt-1 text-xs text-gray-500">The executive only sees and manages this pickup point.</p>
          )}
        </div>

        <div>
          <label htmlFor="executive-password" className="block text-sm font-medium text-gray-700 mb-1">
            {isEdit ? 'New password' : 'Password'}{' '}
            {isEdit ? (
              <span className="font-normal text-gray-400">(optional, leave empty to keep the current one)</span>
            ) : (
              <span className="text-red-500">*</span>
            )}
          </label>
          <div className="relative">
            <input
              id="executive-password"
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={setField('password')}
              maxLength={128}
              autoComplete="new-password"
              spellCheck={false}
              aria-invalid={!!errors.password}
              className={`${inputClass(!!errors.password)} pr-11 ${showPassword ? 'font-mono' : ''}`}
              placeholder={isEdit ? 'Leave empty to keep the current password' : `At least ${MIN_PASSWORD_LENGTH} characters`}
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 px-3 text-gray-500 hover:text-gray-700"
            >
              {showPassword ? <FiEyeOff className="h-4 w-4" /> : <FiEye className="h-4 w-4" />}
            </button>
          </div>
          {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleGenerate}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
            >
              <FiRefreshCw className="h-3.5 w-3.5" />
              Generate strong password
            </button>
            <button
              type="button"
              onClick={handleCopyPassword}
              disabled={!form.password}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <FiCopy className="h-3.5 w-3.5" />
              Copy
            </button>
          </div>
        </div>

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {saving && <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />}
            {saving ? 'Saving...' : isEdit ? 'Save changes' : 'Create executive'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

const DeleteExecutiveModal = ({ executive, deleting, onCancel, onConfirm }) => (
  <Modal
    title="Delete executive"
    icon={<FiTrash2 className="h-5 w-5 text-red-600" />}
    onClose={onCancel}
    busy={deleting}
    maxWidth="sm:max-w-md"
  >
    <div className="flex items-start gap-3">
      <FiAlertCircle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
      <div className="text-sm text-gray-700">
        <p>
          Delete <span className="font-semibold text-gray-900">{executive.name}</span>
          {executive.email ? ` (${executive.email})` : ''}?
        </p>
        <p className="mt-2 text-gray-500">
          They will not be able to log in any more. This cannot be undone. To only pause the access, deactivate the
          executive instead.
        </p>
      </div>
    </div>
    <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
      <button
        type="button"
        onClick={onCancel}
        disabled={deleting}
        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={deleting}
        className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
      >
        {deleting && <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />}
        {deleting ? 'Deleting...' : 'Delete'}
      </button>
    </div>
  </Modal>
);

const RowActions = ({ executive, onEdit, onDelete }) => (
  <div className="flex items-center gap-1">
    <button
      type="button"
      onClick={() => onEdit(executive)}
      title="Edit"
      aria-label={`Edit ${executive.name}`}
      className="p-2 text-blue-600 hover:text-blue-900 hover:bg-blue-50 rounded-lg transition-colors"
    >
      <FiEdit2 className="h-4 w-4" />
    </button>
    <button
      type="button"
      onClick={() => onDelete(executive)}
      title="Delete"
      aria-label={`Delete ${executive.name}`}
      className="p-2 text-red-600 hover:text-red-900 hover:bg-red-50 rounded-lg transition-colors"
    >
      <FiTrash2 className="h-4 w-4" />
    </button>
  </div>
);

const Executives = () => {
  const [executives, setExecutives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [pods, setPods] = useState(PICKUP_PODS);
  const [formState, setFormState] = useState(null); // null = closed, { executive } = add (null) or edit
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const loadExecutives = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setLoadError('');
    try {
      const response = await adminAPI.getExecutives();
      setExecutives(Array.isArray(response && response.data) ? response.data : []);
    } catch (err) {
      setLoadError(errorMessage(err, 'Failed to load executives'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadExecutives();
  }, [loadExecutives]);

  // The pickup points to choose from (the built-in list when the request fails)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await adminAPI.getPickupLocations();
        const list = Array.isArray(response && response.data) ? response.data : [];
        const fromServer = list
          .filter((pod) => pod && pod.key)
          .map((pod) => ({ ...(getPodByKey(pod.key) || {}), ...pod }));
        if (!cancelled && fromServer.length > 0) setPods(fromServer);
      } catch {
        // The two pickup points are fixed, so the built-in list is fine
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedExecutives = useMemo(
    () => [...executives].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)),
    [executives]
  );

  const openCreate = () => setFormState({ executive: null });
  const openEdit = (executive) => setFormState({ executive });
  const closeForm = useCallback(() => setFormState(null), []);

  // Add the saved executive to the list, or merge it into the existing row
  const handleSaved = useCallback(
    (saved) => {
      if (saved && saved._id) {
        setExecutives((prev) =>
          prev.some((item) => item._id === saved._id)
            ? prev.map((item) => (item._id === saved._id ? { ...item, ...saved } : item))
            : [saved, ...prev]
        );
      } else {
        loadExecutives({ silent: true });
      }
    },
    [loadExecutives]
  );

  const handleToggleActive = async (executive) => {
    const activate = executive.isActive === false;
    setBusyId(executive._id);
    try {
      const response = await adminAPI.updateExecutive(executive._id, { isActive: activate });
      const saved = response && response.data && typeof response.data === 'object' ? response.data : {};
      setExecutives((prev) =>
        prev.map((item) => (item._id === executive._id ? { ...item, isActive: activate, ...saved } : item))
      );
      toast.success(activate ? `${executive.name} activated` : `${executive.name} deactivated`);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not change the status'));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await adminAPI.deleteExecutive(deleteTarget._id);
      setExecutives((prev) => prev.filter((item) => item._id !== deleteTarget._id));
      toast.success(`${deleteTarget.name} deleted`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not delete the executive'));
    } finally {
      setDeleting(false);
    }
  };

  const closeDelete = useCallback(() => setDeleteTarget(null), []);

  const showList = !loading && sortedExecutives.length > 0;
  const showEmpty = !loading && !loadError && sortedExecutives.length === 0;

  let subtitle = `${sortedExecutives.length} ${sortedExecutives.length === 1 ? 'executive' : 'executives'}`;
  if (loading) subtitle = 'Loading...';
  else if (loadError && sortedExecutives.length === 0) subtitle = 'Could not load the list';

  return (
    <div className="space-y-6">
      <Toaster position="top-right" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Executives</h1>
          <p className="text-gray-600 mt-1">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => loadExecutives()}
            disabled={loading}
            className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <FiRefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
          >
            <FiPlus className="h-4 w-4" />
            <span>Add Executive</span>
          </button>
        </div>
      </div>

      {/* What executives can do */}
      <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-lg p-4">
        <FiInfo className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
        <p className="text-sm text-blue-800">
          Executives can only use Fleet Manager, Queue Management, Register Driver and Manual Booking, and only for their
          own pickup point.
        </p>
      </div>

      {/* Load error */}
      {loadError && (
        <div role="alert" className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="flex items-center gap-2">
            <FiAlertCircle className="h-5 w-5 text-red-600 flex-shrink-0" />
            <span className="text-sm font-medium text-red-800">{loadError}</span>
          </div>
          <button
            type="button"
            onClick={() => loadExecutives()}
            className="self-start sm:self-auto px-3 py-1.5 text-sm font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-100 transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {(loading || showList || showEmpty) && (
        <ModernCard padding="p-0">
          {loading && (
            <div className="px-6 py-12 flex items-center justify-center space-x-2">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
              <span className="text-gray-500">Loading executives...</span>
            </div>
          )}

          {showEmpty && (
            <div className="px-6 py-12 flex flex-col items-center text-center space-y-3">
              <div className="h-14 w-14 rounded-full bg-gray-100 flex items-center justify-center">
                <FiUsers className="h-7 w-7 text-gray-400" />
              </div>
              <div>
                <p className="text-lg font-medium text-gray-900">No executives yet</p>
                <p className="text-gray-500 max-w-md">
                  Add an executive to let someone run Manual Booking, Fleet Manager, Queue Management and Register Driver
                  for a single pickup point.
                </p>
              </div>
              <button
                type="button"
                onClick={openCreate}
                className="mt-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
              >
                Add First Executive
              </button>
            </div>
          )}

          {showList && (
            <>
              {/* Table (tablet / desktop). w-0 + min-w-full keeps a wide table scrolling inside the card instead of
                  stretching the whole admin layout. */}
              <div className="hidden md:block w-0 min-w-full overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">E-mail</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Pickup point</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last login</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {sortedExecutives.map((executive) => (
                      <tr key={executive._id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-4 whitespace-nowrap">
                          <div className="flex items-center">
                            <div className="flex-shrink-0 h-9 w-9 rounded-full bg-blue-100 flex items-center justify-center text-sm font-semibold text-blue-700">
                              {initialsOf(executive.name)}
                            </div>
                            <div className="ml-3 text-sm font-medium text-gray-900">{executive.name}</div>
                          </div>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-700">{executive.email}</td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <PodBadge executive={executive} />
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <StatusSwitch executive={executive} busy={busyId === executive._id} onToggle={handleToggleActive} />
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-sm">
                          {formatDate(executive.lastLogin) ? (
                            <>
                              <div className="text-gray-700">{formatDate(executive.lastLogin)}</div>
                              <div className="text-xs text-gray-400">{formatTime(executive.lastLogin)}</div>
                            </>
                          ) : (
                            <span className="text-gray-500">Never</span>
                          )}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-sm text-gray-500">
                          {formatDate(executive.createdAt) || '-'}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <RowActions executive={executive} onEdit={openEdit} onDelete={setDeleteTarget} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Cards (phones) */}
              <ul className="md:hidden divide-y divide-gray-100">
                {sortedExecutives.map((executive) => (
                  <li key={executive._id} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center min-w-0">
                        <div className="flex-shrink-0 h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center text-sm font-semibold text-blue-700">
                          {initialsOf(executive.name)}
                        </div>
                        <div className="ml-3 min-w-0">
                          <div className="text-sm font-semibold text-gray-900 truncate">{executive.name}</div>
                          <div className="text-xs text-gray-500 break-all">{executive.email}</div>
                        </div>
                      </div>
                      <PodBadge executive={executive} />
                    </div>
                    <div className="flex items-center justify-between">
                      <StatusSwitch executive={executive} busy={busyId === executive._id} onToggle={handleToggleActive} />
                      <RowActions executive={executive} onEdit={openEdit} onDelete={setDeleteTarget} />
                    </div>
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>Last login: {formatDateTime(executive.lastLogin) || 'Never'}</span>
                      <span>Created: {formatDate(executive.createdAt) || '-'}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </ModernCard>
      )}

      {formState && (
        <ExecutiveFormModal
          key={formState.executive ? formState.executive._id : 'new'}
          executive={formState.executive}
          pods={pods}
          onClose={closeForm}
          onSaved={handleSaved}
        />
      )}

      {deleteTarget && (
        <DeleteExecutiveModal
          executive={deleteTarget}
          deleting={deleting}
          onCancel={closeDelete}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
};

export default Executives;
