import React, { useState, useEffect } from 'react';
import { FaSave, FaSync, FaHistory, FaCar, FaMotorcycle, FaTaxi, FaCalculator, FaTimes, FaMoon, FaMoneyBillWave } from 'react-icons/fa';
import { admin } from '../../services/api';

const FareManagement = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentTab, setCurrentTab] = useState('vehicle');
  const [config, setConfig] = useState(null);
  const [simulationData, setSimulationData] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState([]);
  const [alert, setAlert] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  // Simulation form state
  const [simulation, setSimulation] = useState({
    vehicleType: 'auto',
    distance: 10,
    waitingTime: 0,
    pickupStation: ''
  });

  useEffect(() => {
    fetchFareConfig();
  }, []);

  const fetchFareConfig = async () => {
    try {
      setLoading(true);
      const response = await admin.getFareConfig();
      if (response.success) {
        setConfig(response.config);
        // Auto-open Night Charge tab when it's disabled so it's immediately visible
        if (response.config?.nightCharge?.isActive === false) {
          setCurrentTab('night');
        }
      }
    } catch (error) {
      showAlert('error', 'Failed to fetch fare configuration');
    } finally {
      setLoading(false);
    }
  };

  const fetchHistory = async () => {
    try {
      const response = await admin.getFareHistory();
      if (response.success) {
        setHistory(response.history);
        setShowHistory(true);
      }
    } catch (error) {
      showAlert('error', 'Failed to fetch history');
    }
  };

  const showAlert = (type, message) => {
    setAlert({ type, message });
    setTimeout(() => setAlert(null), 5000);
  };

  // Vehicle config editing REMOVED — formulas are hardcoded in fareCalculator.js
  // saveSurgeConfig and saveDynamicPricing REMOVED — features disabled

  const handleNightChargeChange = (field, value) => {
    setConfig(prev => ({
      ...prev,
      nightCharge: {
        ...prev.nightCharge,
        [field]: field === 'isActive' ? value : parseFloat(value)
      }
    }));
  };

  const saveNightCharge = async () => {
    setConfirmDialog({
      title: 'Update Night Charge Settings',
      message: 'Are you sure you want to update night charge settings? This will affect all rides during night hours.',
      onConfirm: async () => {
        try {
          setSaving(true);
          const response = await admin.updateNightCharge(config.nightCharge);
          if (response.success) {
            showAlert('success', 'Night charge settings updated successfully');
            fetchFareConfig();
          }
        } catch (error) {
          showAlert('error', 'Failed to update night charge settings');
        } finally {
          setSaving(false);
          setConfirmDialog(null);
        }
      }
    });
  };

  const runSimulation = async () => {
    try {
      const response = await admin.simulateFare(simulation);
      if (response.success) {
        setSimulationData(response.simulation);
      }
    } catch (error) {
      showAlert('error', 'Failed to run simulation');
    }
  };

  const restoreConfig = async (configId) => {
    setConfirmDialog({
      title: 'Restore Configuration',
      message: 'Are you sure you want to restore this configuration? Current configuration will be replaced.',
      onConfirm: async () => {
        try {
          setSaving(true);
          const response = await admin.restoreFareConfig(configId);
          if (response.success) {
            showAlert('success', 'Configuration restored successfully');
            fetchFareConfig();
            setShowHistory(false);
          }
        } catch (error) {
          showAlert('error', 'Failed to restore configuration');
        } finally {
          setSaving(false);
          setConfirmDialog(null);
        }
      }
    });
  };


  const tabs = [
    { id: 'vehicle', label: 'Vehicle Pricing', icon: <FaCar /> },
    // Surge Pricing and Dynamic Pricing tabs removed - features disabled
    { id: 'night', label: 'Night Charge', icon: <FaMoon /> },
    { id: 'simulator', label: 'Fare Simulator', icon: <FaCalculator /> }
  ];

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-screen">
        <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="bg-red-50 border border-red-200 text-red-800 p-4 rounded-lg">
        Failed to load fare configuration
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      <div className="bg-white rounded-xl shadow-lg">
        {/* Header */}
        <div className="p-6 border-b border-gray-200">
          <div className="flex justify-between items-center">
            <h1 className="text-3xl font-bold text-gray-800">Fare Management</h1>
            <div className="flex gap-2">
              <button
                onClick={fetchFareConfig}
                className="p-2 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                title="Refresh"
              >
                <FaSync className="text-gray-600" />
              </button>
              <button
                onClick={fetchHistory}
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center gap-2 transition-colors"
              >
                <FaHistory />
                View History
              </button>
            </div>
          </div>
        </div>

        {/* Alert */}
        {alert && (
          <div className={`mx-6 mt-4 p-4 rounded-lg ${
            alert.type === 'success' ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'
          }`}>
            {alert.message}
          </div>
        )}

        {/* Night Charge Disabled Warning Banner */}
        {config && !config.nightCharge?.isActive && (
          <div className="mx-6 mt-4 p-3 bg-red-50 border border-red-300 rounded-lg flex items-center gap-2 text-red-700 text-sm font-medium">
            <FaMoon className="flex-shrink-0" />
            <span>
              Night Charge is currently <strong>DISABLED</strong> — customers are not being charged after-hours rates (8 PM – 8 AM).
            </span>
            <button
              onClick={() => setCurrentTab('night')}
              className="ml-auto whitespace-nowrap underline hover:no-underline"
            >
              Enable it →
            </button>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-gray-200 px-6 mt-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setCurrentTab(tab.id)}
              className={`px-4 py-3 font-medium flex items-center gap-2 border-b-2 transition-colors ${
                currentTab === tab.id
                  ? 'text-blue-600 border-blue-600'
                  : 'text-gray-500 border-transparent hover:text-gray-700'
              }`}
            >
              {tab.icon}
              {tab.label}
              {tab.id === 'night' && config && !config.nightCharge?.isActive && (
                <span className="ml-1 px-1.5 py-0.5 text-xs bg-red-500 text-white rounded-full leading-none">OFF</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {/* Vehicle Pricing Tab */}
          {currentTab === 'vehicle' && (
            <div>
              {/* Fare Calculation Formula Display */}
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6 mb-6">
                <h3 className="text-lg font-semibold mb-4 flex items-center gap-2 text-blue-800">
                  <FaCalculator className="text-blue-600" /> Fare Calculation Formula
                </h3>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Driver Fare Formula — AUTO */}
                  <div className="bg-white p-4 rounded-lg border border-green-200 shadow-sm">
                    <h4 className="font-medium text-green-700 mb-3 flex items-center gap-2">
                      <FaCar className="text-green-600" /> Driver Earns — AUTO (Piecewise)
                    </h4>
                    <table className="text-sm w-full">
                      <thead><tr className="text-left text-gray-500 border-b"><th className="pb-1">Range</th><th className="pb-1">Formula</th></tr></thead>
                      <tbody className="font-mono">
                        <tr><td className="py-1 pr-4">0 – 2 km</td><td className="text-green-600 font-bold">₹50 (flat)</td></tr>
                        <tr><td className="py-1 pr-4">2 – 6 km</td><td className="text-green-600 font-bold">20x + 10</td></tr>
                        <tr><td className="py-1 pr-4">&gt; 6 km</td><td className="text-green-600 font-bold">30x − 50</td></tr>
                      </tbody>
                    </table>
                    <div className="text-xs text-orange-600 mt-2">Night ({config.nightCharge?.startHour ?? 20}:00–{config.nightCharge?.endHour ?? 8}:00): +{config.nightCharge?.driverPercentage ?? 25}%</div>
                  </div>

                  {/* Customer Fare Formula — AUTO */}
                  <div className="bg-white p-4 rounded-lg border border-blue-200 shadow-sm">
                    <h4 className="font-medium text-blue-700 mb-3 flex items-center gap-2">
                      <FaMoneyBillWave className="text-blue-600" /> Customer Pays — AUTO (Piecewise)
                    </h4>
                    <table className="text-sm w-full">
                      <thead><tr className="text-left text-gray-500 border-b"><th className="pb-1">Range</th><th className="pb-1">Formula</th></tr></thead>
                      <tbody className="font-mono">
                        <tr><td className="py-1 pr-4">0.1 – 1 km</td><td className="text-blue-600 font-bold">₹52 (flat)</td></tr>
                        <tr><td className="py-1 pr-4">1 – 2 km</td><td className="text-blue-600 font-bold">10x + 40</td></tr>
                        <tr><td className="py-1 pr-4">2 – 6 km</td><td className="text-blue-600 font-bold">21x + 18</td></tr>
                        <tr><td className="py-1 pr-4">&gt; 6 km</td><td className="text-blue-600 font-bold">29x − 29</td></tr>
                      </tbody>
                    </table>
                    <div className="text-xs text-orange-600 mt-2">Night ({config.nightCharge?.startHour ?? 20}:00–{config.nightCharge?.endHour ?? 8}:00): +{config.nightCharge?.userPercentage ?? 30}%</div>
                    <div className="text-xs text-gray-500 mt-1">Platform Spread = Customer − Driver. No commission, no GST.</div>
                  </div>
                </div>

                {/* Example */}
                <div className="mt-4 bg-yellow-50 p-4 rounded-lg border border-yellow-200">
                  <h4 className="font-medium mb-2 text-yellow-800">Example: 5km AUTO Ride (Day Time)</h4>
                  <div className="text-sm grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-white p-2 rounded"><strong className="text-green-700">Driver:</strong> 20×5 + 10 = <span className="font-bold">₹110</span></div>
                    <div className="bg-white p-2 rounded"><strong className="text-blue-700">Customer:</strong> 21×5 + 18 = <span className="font-bold">₹123</span></div>
                    <div className="bg-white p-2 rounded"><strong className="text-yellow-700">Platform:</strong> 123 − 110 = <span className="font-bold">₹13</span></div>
                  </div>
                </div>

                <div className="mt-4 bg-gray-100 p-3 rounded-lg text-sm text-gray-600">
                  <strong>Note:</strong> Fare formulas are hardcoded in the server. No editable fields — only Night Charge percentages and hours are configurable.
                </div>
              </div>
            </div>
          )}

          {/* Surge Pricing Tab - REMOVED (feature disabled) */}
          {/* Dynamic Pricing Tab - REMOVED (feature disabled) */}

          {/* Night Charge Tab */}
          {currentTab === 'night' && (
            <div>
              <h3 className="text-xl font-semibold mb-4">Night Charge Configuration</h3>

              <div className="bg-gray-50 rounded-lg p-6 max-w-2xl">
                <div className="space-y-6">
                  {/* Enable/Disable Toggle */}
                  <div className="flex items-center justify-between p-4 bg-white rounded-lg border border-gray-200">
                    <div>
                      <h4 className="font-medium text-gray-900">Enable Night Charge</h4>
                      <p className="text-sm text-gray-500">Apply additional charge during night hours</p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={config.nightCharge?.isActive || false}
                        onChange={(e) => handleNightChargeChange('isActive', e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                    </label>
                  </div>

                  {/* Night Hours */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Start Hour (24-hour format)
                      </label>
                      <select
                        value={config.nightCharge?.startHour ?? 20}
                        onChange={(e) => handleNightChargeChange('startHour', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {[...Array(24)].map((_, hour) => (
                          <option key={hour} value={hour}>
                            {hour.toString().padStart(2, '0')}:00
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">Night charge starts at this hour</p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        End Hour (24-hour format)
                      </label>
                      <select
                        value={config.nightCharge?.endHour ?? 8}
                        onChange={(e) => handleNightChargeChange('endHour', e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {[...Array(24)].map((_, hour) => (
                          <option key={hour} value={hour}>
                            {hour.toString().padStart(2, '0')}:00
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-gray-500 mt-1">Night charge ends at this hour</p>
                    </div>
                  </div>

                  {/* User Night Percentage */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Customer Night Charge (%) — User pays this % extra
                    </label>
                    <input
                      type="number"
                      value={config.nightCharge?.userPercentage ?? 30}
                      onChange={(e) => handleNightChargeChange('userPercentage', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      min="0"
                      max="100"
                      step="1"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Customer pays: dayFare × (1 + userPercentage/100)
                    </p>
                  </div>

                  {/* Driver Night Percentage */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Driver Night Bonus (%) — Driver earns this % extra
                    </label>
                    <input
                      type="number"
                      value={config.nightCharge?.driverPercentage ?? 25}
                      onChange={(e) => handleNightChargeChange('driverPercentage', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      min="0"
                      max="100"
                      step="1"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Driver earns: dayFare × (1 + driverPercentage/100)
                    </p>
                  </div>

                  {/* Preview */}
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                    <h5 className="font-medium text-blue-900 mb-2">Current Configuration:</h5>
                    <ul className="text-sm text-blue-800 space-y-1">
                      <li>
                        <span className="font-medium">Status:</span>{' '}
                        {config.nightCharge?.isActive ? (
                          <span className="text-green-600">✓ Enabled</span>
                        ) : (
                          <span className="text-red-600">✗ Disabled</span>
                        )}
                      </li>
                      <li>
                        <span className="font-medium">Night Hours:</span>{' '}
                        {String(config.nightCharge?.startHour ?? 20).padStart(2, '0')}:00 to{' '}
                        {String(config.nightCharge?.endHour ?? 8).padStart(2, '0')}:00
                      </li>
                      <li>
                        <span className="font-medium">User Night Charge:</span>{' '}
                        +{config.nightCharge?.userPercentage ?? 30}% on day fare
                      </li>
                      <li>
                        <span className="font-medium">Driver Night Bonus:</span>{' '}
                        +{config.nightCharge?.driverPercentage ?? 25}% on day fare
                      </li>
                      <li className="mt-2 pt-2 border-t border-blue-300 text-xs">
                        <span className="font-medium">Example (5km auto, night):</span><br/>
                        Driver: ₹110 × 1.{String(config.nightCharge?.driverPercentage ?? 25).padStart(2,'0')} = ₹{Math.round(110 * (1 + (config.nightCharge?.driverPercentage ?? 25)/100))}<br/>
                        Customer: ₹123 × 1.{String(config.nightCharge?.userPercentage ?? 30).padStart(2,'0')} = ₹{Math.round(123 * (1 + (config.nightCharge?.userPercentage ?? 30)/100))}
                      </li>
                    </ul>
                  </div>
                </div>

                {/* Save Button */}
                <button
                  onClick={saveNightCharge}
                  disabled={saving}
                  className="mt-6 w-full px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white rounded-lg flex items-center justify-center gap-2 transition-colors disabled:bg-gray-400"
                >
                  <FaSave />
                  Save Night Charge Settings
                </button>
              </div>
            </div>
          )}

          {/* Fare Simulator Tab */}
          {currentTab === 'simulator' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-gray-50 rounded-lg p-6">
                <h3 className="text-xl font-semibold mb-4">Fare Simulator</h3>
                
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Vehicle Type
                    </label>
                    <select
                      value={simulation.vehicleType}
                      onChange={(e) => setSimulation({...simulation, vehicleType: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="bike">Bike</option>
                      <option value="auto">Auto</option>
                      <option value="car">Car</option>
                    </select>
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Distance (KM)
                    </label>
                    <input
                      type="number"
                      value={simulation.distance}
                      onChange={(e) => setSimulation({...simulation, distance: parseFloat(e.target.value)})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      min="0.1"
                      step="0.5"
                    />
                  </div>
                  
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Pickup Station (Optional)
                    </label>
                    <input
                      type="text"
                      value={simulation.pickupStation}
                      onChange={(e) => setSimulation({...simulation, pickupStation: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Enter station name (optional)"
                    />
                  </div>
                  
                  <button
                    onClick={runSimulation}
                    className="w-full px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                  >
                    Calculate Fare
                  </button>
                </div>
              </div>
              
              {simulationData && (
                <div className="bg-gray-50 rounded-lg p-6">
                  <h3 className="text-xl font-semibold mb-4">Simulation Result</h3>

                  <div className="space-y-2">
                    <div className="flex justify-between py-2 border-b border-gray-200">
                      <span className="text-gray-600">Vehicle Type</span>
                      <span className="font-medium capitalize">{simulationData.vehicleType}</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-200">
                      <span className="text-gray-600">Distance</span>
                      <span className="font-medium">{simulationData.distance} KM</span>
                    </div>
                    <div className="flex justify-between py-2 border-b border-gray-200 bg-green-50 px-2 rounded">
                      <span className="text-green-700 font-medium">Driver Fare</span>
                      <span className="font-bold text-green-700">₹{simulationData.driverFare}</span>
                    </div>
                    {simulationData.isNightCharge && (
                      <div className="flex justify-between py-2 border-b border-gray-200 bg-yellow-50 px-2 rounded">
                        <span className="text-yellow-700">Night Charge — User (+{config.nightCharge?.userPercentage ?? 30}%)</span>
                        <span className="font-medium text-yellow-700">₹{simulationData.nightChargeUserAmount}</span>
                      </div>
                    )}
                    {simulationData.isNightCharge && (
                      <div className="flex justify-between py-2 border-b border-gray-200 bg-yellow-50 px-2 rounded">
                        <span className="text-yellow-700">Night Charge — Driver (+{config.nightCharge?.driverPercentage ?? 25}%)</span>
                        <span className="font-medium text-yellow-700">₹{simulationData.nightChargeDriverAmount}</span>
                      </div>
                    )}
                    <div className="flex justify-between py-2 border-b border-gray-200">
                      <span className="text-gray-600">Platform Spread (Customer − Driver)</span>
                      <span className="font-medium">₹{simulationData.platformEarning}</span>
                    </div>
                    <div className="flex justify-between py-3 border-t-2 border-gray-300 bg-blue-50 px-2 rounded">
                      <span className="text-lg font-semibold text-blue-800">Customer Pays</span>
                      <span className="text-2xl font-bold text-blue-600">₹{simulationData.customerTotalFare}</span>
                    </div>
                  </div>

                  <div className="mt-4 p-3 bg-gray-100 rounded-lg">
                    <p className="text-sm text-gray-600 font-medium mb-1">Summary:</p>
                    <p className="text-sm text-green-700">Driver Earns: ₹{simulationData.driverFare}</p>
                    <p className="text-sm text-blue-700">Platform Earns: ₹{simulationData.platformEarning}</p>
                    <p className="text-sm text-gray-800 font-semibold">Customer Pays: ₹{simulationData.customerTotalFare}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* History Modal */}
      {showHistory && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl max-w-4xl w-full max-h-[80vh] overflow-hidden">
            <div className="p-6 border-b border-gray-200 flex justify-between items-center">
              <h2 className="text-2xl font-bold">Fare Configuration History</h2>
              <button
                onClick={() => setShowHistory(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <FaTimes className="text-gray-600" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto max-h-[60vh]">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="px-4 py-2 text-left">Version</th>
                    <th className="px-4 py-2 text-left">Updated By</th>
                    <th className="px-4 py-2 text-left">Date</th>
                    <th className="px-4 py-2 text-left">Notes</th>
                    <th className="px-4 py-2 text-left">Status</th>
                    <th className="px-4 py-2 text-left">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((item) => (
                    <tr key={item._id} className="border-b border-gray-200">
                      <td className="px-4 py-2">{item.version}</td>
                      <td className="px-4 py-2">{item.updatedByName || 'System'}</td>
                      <td className="px-4 py-2">
                        {new Date(item.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-2">{item.notes || '-'}</td>
                      <td className="px-4 py-2">
                        <span className={`px-2 py-1 rounded-full text-sm font-medium ${
                          item.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {item.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        {!item.isActive && (
                          <button
                            onClick={() => restoreConfig(item._id)}
                            className="text-blue-500 hover:text-blue-700 text-sm font-medium"
                          >
                            Restore
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl max-w-md w-full p-6">
            <h3 className="text-xl font-bold mb-2">{confirmDialog.title}</h3>
            <p className="text-gray-600 mb-6">{confirmDialog.message}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDialog.onConfirm}
                disabled={saving}
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors disabled:bg-gray-400"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FareManagement;