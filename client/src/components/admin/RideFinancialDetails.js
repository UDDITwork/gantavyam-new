import React, { useState, useEffect } from 'react';
import { FaRupeeSign, FaChartLine, FaCar, FaUser, FaBuilding, FaReceipt, FaMoneyBillWave, FaMoon, FaCheckCircle, FaTimesCircle, FaClock } from 'react-icons/fa';

const RideFinancialDetails = ({ ride, showSummary = true }) => {
  const [financialData, setFinancialData] = useState({
    driverEarnings: 0,
    platformRevenue: 0,
    customerTotal: 0,
    nightChargeUserAmount: 0,
    nightChargeDriverAmount: 0
  });

  useEffect(() => {
    if (ride) {
      calculateFinancials();
    }
  }, [ride]);

  const calculateFinancials = () => {
    if (!ride) return;

    const driverFare = ride.driverFare || ride.fare || 0;
    const customerFare = ride.customerFare || ride.estimatedFare || 0;
    // Platform earns the spread — no commission, no GST
    const platformRevenue = Math.max(0, customerFare - driverFare);
    // Night charge amounts (new fields)
    const nightChargeUserAmount = ride.fareBreakdown?.nightChargeUserAmount || ride.nightChargeAmount || 0;
    const nightChargeDriverAmount = ride.fareBreakdown?.nightChargeDriverAmount || 0;

    setFinancialData({
      driverEarnings: Math.max(0, driverFare),
      platformRevenue,
      customerTotal: Math.max(0, customerFare),
      nightChargeUserAmount: Math.max(0, nightChargeUserAmount),
      nightChargeDriverAmount: Math.max(0, nightChargeDriverAmount)
    });
  };

  const getPaymentStatusIcon = () => {
    if (!ride?.paymentStatus) return <FaClock className="text-yellow-500" />;

    switch (ride.paymentStatus) {
      case 'collected':
        return <FaCheckCircle className="text-green-500" />;
      case 'pending':
        return <FaClock className="text-yellow-500" />;
      case 'failed':
        return <FaTimesCircle className="text-red-500" />;
      default:
        return <FaClock className="text-gray-500" />;
    }
  };

  const getPaymentStatusColor = () => {
    if (!ride?.paymentStatus) return 'bg-yellow-100 text-yellow-800';

    switch (ride.paymentStatus) {
      case 'collected':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (!ride) {
    return (
      <div className="bg-gray-50 rounded-lg p-6 text-center">
        <p className="text-gray-500">No ride selected</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Financial Overview Cards */}
      {showSummary && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Driver Earnings Card */}
          <div className="bg-gradient-to-r from-green-50 to-green-100 rounded-lg p-4 border border-green-200">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <FaCar className="text-green-600" />
                  <span className="text-sm font-medium text-gray-700">Driver Earnings</span>
                </div>
                <div className="text-2xl font-bold text-green-700">
                  ₹{financialData.driverEarnings}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  What driver earns
                </div>
              </div>
              <FaMoneyBillWave className="text-green-300 text-3xl" />
            </div>
          </div>

          {/* Platform Revenue Card */}
          <div className="bg-gradient-to-r from-blue-50 to-blue-100 rounded-lg p-4 border border-blue-200">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <FaBuilding className="text-blue-600" />
                  <span className="text-sm font-medium text-gray-700">Platform Spread</span>
                </div>
                <div className="text-2xl font-bold text-blue-700">
                  ₹{financialData.platformRevenue}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  Customer − Driver (built-in spread)
                </div>
              </div>
              <FaChartLine className="text-blue-300 text-3xl" />
            </div>
          </div>

          {/* Customer Total Card */}
          <div className="bg-gradient-to-r from-purple-50 to-purple-100 rounded-lg p-4 border border-purple-200">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <FaUser className="text-purple-600" />
                  <span className="text-sm font-medium text-gray-700">Customer Total</span>
                </div>
                <div className="text-2xl font-bold text-purple-700">
                  ₹{financialData.customerTotal}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  Total amount paid by customer
                </div>
              </div>
              <FaRupeeSign className="text-purple-300 text-3xl" />
            </div>
          </div>
        </div>
      )}

      {/* Detailed Fare Breakdown */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <div className="bg-gradient-to-r from-gray-50 to-gray-100 px-6 py-4 border-b border-gray-200">
          <h3 className="text-lg font-semibold text-gray-800 flex items-center gap-2">
            <FaReceipt className="text-gray-600" />
            Complete Fare Breakdown
          </h3>
        </div>

        <div className="p-6 space-y-4">
          {/* Base Fare Section */}
          <div className="space-y-3">
            <div className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Base Calculations</div>

            <div className="bg-green-50 rounded-lg p-4 border border-green-200">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <FaCar className="text-green-600" />
                  <span className="font-medium text-gray-800">Driver Base Fare</span>
                </div>
                <span className="text-lg font-bold text-green-700">₹{financialData.driverEarnings}</span>
              </div>
              <div className="text-xs text-gray-600 mt-2">
                {ride.distance ? `${ride.distance} km (piecewise formula)` : 'Piecewise linear formula'}
              </div>
            </div>

            {/* Surge Pricing - REMOVED (feature disabled) */}
          </div>

          {/* Platform Spread Section */}
          <div className="space-y-3">
            <div className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Platform Spread</div>

            <div className="bg-blue-50 rounded-lg p-4 border border-blue-200">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <FaChartLine className="text-blue-600" />
                  <span className="font-medium text-gray-800">Platform Earns</span>
                </div>
                <span className="text-lg font-semibold text-blue-700">₹{financialData.platformRevenue}</span>
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Customer ₹{financialData.customerTotal} − Driver ₹{financialData.driverEarnings} = ₹{financialData.platformRevenue}
              </div>
            </div>

            {/* Night Charge */}
            {(financialData.nightChargeUserAmount > 0 || financialData.nightChargeDriverAmount > 0) && (
              <div className="bg-purple-50 rounded-lg p-4 border border-purple-200">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <FaMoon className="text-purple-600" />
                    <span className="font-medium text-gray-800">Night Charge (8 PM – 8 AM)</span>
                  </div>
                </div>
                <div className="text-xs text-gray-600 mt-2 space-y-1">
                  <div>User extra: ₹{financialData.nightChargeUserAmount}</div>
                  <div>Driver extra: ₹{financialData.nightChargeDriverAmount}</div>
                </div>
              </div>
            )}
          </div>

          {/* Summary Section */}
          <div className="border-t-2 border-gray-200 pt-4 space-y-3">
            <div className="flex justify-between items-center text-lg">
              <span className="font-semibold text-gray-800">Customer Total</span>
              <span className="font-bold text-blue-700">₹{financialData.customerTotal}</span>
            </div>

            <div className="bg-yellow-50 rounded-lg p-4 border border-yellow-200">
              <div className="flex justify-between items-center">
                <div>
                  <div className="font-semibold text-gray-800">Platform Earnings</div>
                  <div className="text-xs text-gray-600 mt-1">
                    Customer − Driver (built-in spread)
                  </div>
                </div>
                <span className="text-xl font-bold text-yellow-700">₹{financialData.platformRevenue}</span>
              </div>
            </div>
          </div>

          {/* Payment Status */}
          <div className="border-t border-gray-200 pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getPaymentStatusIcon()}
                <span className="font-medium text-gray-700">Payment Status</span>
              </div>
              <span className={`px-3 py-1 rounded-full text-sm font-medium ${getPaymentStatusColor()}`}>
                {ride.paymentStatus || 'Pending'}
              </span>
            </div>
            {ride.paymentMethod && (
              <div className="mt-2 text-sm text-gray-600">
                Payment Method: <span className="font-medium">
                  {ride.paymentMethod === 'cash' ? '💵 CASH' :
                   ride.paymentMethod === 'upi' ? '📱 UPI' :
                   ride.paymentMethod === 'online' ? '🌐 ONLINE' :
                   ride.paymentMethod.toUpperCase()}
                </span>
              </div>
            )}
            {ride.paymentCollectedAt && (
              <div className="mt-1 text-sm text-gray-600">
                Collected at: <span className="font-medium">{new Date(ride.paymentCollectedAt).toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default RideFinancialDetails;