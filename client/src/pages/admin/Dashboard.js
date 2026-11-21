import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FaCar, FaRupeeSign, FaUserCheck, FaHourglassHalf, FaSpinner, FaClipboardList, FaUsers } from 'react-icons/fa';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import { admin as adminAPI } from '../../services/api';
import ModernCard from '../../components/admin/ModernCard';
import QuickActions from '../../components/admin/QuickActions';
import FinancialSummary from '../../components/admin/FinancialSummary';
import { useAdmin } from '../../contexts/AdminContext';

const Dashboard = () => {
  const navigate = useNavigate();
  const { hasPermission, PERMISSIONS } = useAdmin();
  const [currentTime, setCurrentTime] = useState(new Date());
  const [loading, setLoading] = useState(true);

  // Stats state
  const [stats, setStats] = useState({
    todayRides: 0,
    todayRevenue: 0,
    activeDrivers: 0,
    pendingBookings: 0,
    completedToday: 0,
    cancelledToday: 0,
    totalBookings: 0,
    totalDrivers: 0
  });

  // Charts data
  const [ridesChartData, setRidesChartData] = useState([]);
  const [revenueChartData, setRevenueChartData] = useState([]);
  const [hasRealChartData, setHasRealChartData] = useState(false);
  const [chartDataStatus, setChartDataStatus] = useState('loading'); // 'loading' | 'real' | 'empty' | 'demo'

  useEffect(() => {
    const token = localStorage.getItem('adminToken');
    if (!token) {
      navigate('/admin/login');
    }
  }, [navigate]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch all dashboard data
  useEffect(() => {
    fetchDashboardData();
    // Refresh every 30 seconds
    const refreshInterval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(refreshInterval);
  }, []);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);

      // Fetch dashboard stats and financial summary in parallel
      const [dashboardRes, financialRes, trendsRes] = await Promise.all([
        adminAPI.getDashboardStats().catch(err => ({ success: false })),
        adminAPI.getFinancialSummary({ period: 'today' }).catch(err => ({ success: false })),
        adminAPI.getRevenueTrends({ period: 'week', groupBy: 'day' }).catch(err => ({ success: false }))
      ]);

      // Process dashboard stats
      if (dashboardRes.success) {
        const data = dashboardRes.data;
        setStats(prev => ({
          ...prev,
          todayRides: data.todayRides || 0,
          activeDrivers: data.activeDrivers || 0,
          pendingBookings: data.activeRides || 0,
          completedToday: data.completedToday || 0,
          cancelledToday: data.cancelledToday || 0,
          totalBookings: data.totalRides || 0,
          totalDrivers: data.driverCount || 0
        }));
      }

      // Process financial summary
      if (financialRes.success) {
        const financial = financialRes.data;
        setStats(prev => ({
          ...prev,
          todayRevenue: financial.totalRevenue || financial.todayRevenue || 0
        }));
      }

      // Process trends for charts
      if (trendsRes.success && trendsRes.data) {
        const trends = Array.isArray(trendsRes.data) ? trendsRes.data : (trendsRes.data.trends || []);

        console.log('📊 [Dashboard] Trends data received:', trends.length, 'data points');

        if (trends.length > 0) {
          // Format data for charts - API returns { date, revenue, rides, ... }
          const formattedData = trends.map(item => {
            let dateStr = item.date;
            // Handle _id object format from MongoDB aggregation (e.g., {year: 2026, month: 2, day: 2})
            if (!dateStr && item._id && typeof item._id === 'object') {
              if (item._id.day && item._id.month && item._id.year) {
                dateStr = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
              }
            } else if (!dateStr) {
              dateStr = item._id;
            }
            return {
              date: formatChartDate(dateStr),
              rides: item.rides || 0,
              revenue: item.revenue || 0
            };
          });

          // Sort by date
          formattedData.sort((a, b) => new Date(a.date) - new Date(b.date));

          console.log('📊 [Dashboard] Real chart data:', formattedData);
          setRidesChartData(formattedData);
          setRevenueChartData(formattedData);
          setHasRealChartData(true);
          setChartDataStatus('real');
        } else {
          // No completed rides in last 7 days - show empty chart with zeros
          console.log('📊 [Dashboard] No completed rides in last 7 days');
          const emptyData = generateEmptyChartData();
          setRidesChartData(emptyData);
          setRevenueChartData(emptyData);
          setHasRealChartData(false);
          setChartDataStatus('empty');
        }
      } else {
        // API failed - show demo data with indicator
        console.log('📊 [Dashboard] Trends API failed, showing demo data');
        const demoData = generateDemoChartData();
        setRidesChartData(demoData);
        setRevenueChartData(demoData);
        setHasRealChartData(false);
        setChartDataStatus('demo');
      }

    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatChartDate = (dateStr) => {
    if (!dateStr) return '';
    // Handle both YYYY-MM-DD format from API and Date objects
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      console.warn('Invalid date:', dateStr);
      return dateStr; // Return original if parsing fails
    }
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const generateEmptyChartData = () => {
    // Generate last 7 days with zero values (when no real data exists)
    const data = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      data.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        rides: 0,
        revenue: 0
      });
    }
    return data;
  };

  const generateDemoChartData = () => {
    // Demo data only shown when API completely fails
    const data = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      data.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        rides: Math.floor(Math.random() * 50) + 10,
        revenue: Math.floor(Math.random() * 5000) + 1000
      });
    }
    return data;
  };

  const formatTime = (date) => {
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const formatDate = (date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  // Stats cards configuration
  const statsCards = [
    {
      title: "Today's Rides",
      value: stats.todayRides,
      icon: <FaCar className="text-white" />,
      bgColor: 'bg-blue-500',
      onClick: () => navigate('/admin/ride-management')
    },
    {
      title: "Today's Revenue",
      value: formatCurrency(stats.todayRevenue),
      icon: <FaRupeeSign className="text-white" />,
      bgColor: 'bg-green-500',
      onClick: () => navigate('/admin/reports')
    },
    {
      title: 'Active Drivers',
      value: stats.activeDrivers,
      icon: <FaUserCheck className="text-white" />,
      bgColor: 'bg-purple-500',
      onClick: () => navigate('/admin/drivers')
    },
    {
      title: 'Pending Bookings',
      value: stats.pendingBookings,
      icon: <FaHourglassHalf className="text-white" />,
      bgColor: 'bg-orange-500',
      onClick: () => navigate('/admin/fleet-manager')
    },
    {
      title: 'Total Bookings',
      value: stats.totalBookings,
      icon: <FaClipboardList className="text-white" />,
      bgColor: 'bg-indigo-500',
      onClick: () => navigate('/admin/ride-management')
    },
    {
      title: 'Total Drivers',
      value: stats.totalDrivers,
      icon: <FaUsers className="text-white" />,
      bgColor: 'bg-teal-500',
      onClick: () => navigate('/admin/drivers')
    }
  ];

  return (
    <div className="space-y-6">
      {/* Welcome Section */}
      <div className="bg-gradient-to-r from-blue-600 to-blue-700 rounded-lg p-6 text-white">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold mb-2">Dashboard</h1>
            <p className="text-blue-100">Here's what's happening with your Gantavyam platform today.</p>
          </div>
          <div className="text-right">
            <p className="text-blue-100 text-sm">{formatDate(currentTime)}</p>
            <p className="text-xl font-mono font-bold">{formatTime(currentTime)}</p>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {statsCards.map((card, index) => (
          <div
            key={index}
            onClick={card.onClick}
            className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 cursor-pointer hover:shadow-md transition-shadow"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-500">{card.title}</p>
                <p className="text-2xl font-bold text-gray-900 mt-1">
                  {loading ? <FaSpinner className="animate-spin text-gray-400" /> : card.value}
                </p>
              </div>
              <div className={`p-3 rounded-lg ${card.bgColor}`}>
                {card.icon}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Rides Trend Chart */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Rides Trend (Last 7 Days)</h3>
            {!loading && chartDataStatus === 'real' && (
              <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded">Live Data</span>
            )}
            {!loading && chartDataStatus === 'empty' && (
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">No completed rides</span>
            )}
            {!loading && chartDataStatus === 'demo' && (
              <span className="text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded">Demo Data</span>
            )}
          </div>
          <div className="h-64">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <FaSpinner className="animate-spin text-blue-500 text-2xl" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={ridesChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                    formatter={(value) => [value, 'Rides']}
                  />
                  <Bar dataKey="rides" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Revenue Trend Chart */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Revenue Trend (Last 7 Days)</h3>
            {!loading && chartDataStatus === 'real' && (
              <span className="text-xs text-green-600 bg-green-50 px-2 py-1 rounded">Live Data</span>
            )}
            {!loading && chartDataStatus === 'empty' && (
              <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">No completed rides</span>
            )}
            {!loading && chartDataStatus === 'demo' && (
              <span className="text-xs text-orange-600 bg-orange-50 px-2 py-1 rounded">Demo Data</span>
            )}
          </div>
          <div className="h-64">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <FaSpinner className="animate-spin text-green-500 text-2xl" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={revenueChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} tickFormatter={(value) => `₹${value}`} />
                  <Tooltip
                    contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                    formatter={(value) => [`₹${value}`, 'Revenue']}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke="#10B981"
                    strokeWidth={2}
                    dot={{ fill: '#10B981', strokeWidth: 2, r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      {/* Financial Dashboard */}
      {hasPermission(PERMISSIONS.FINANCIAL_VIEW) && (
        <FinancialSummary
          rides={[]}
          onRefresh={fetchDashboardData}
          loading={loading}
        />
      )}

      {/* Quick Actions */}
      <QuickActions />

      {/* Quick Stats Footer */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between text-sm text-gray-600">
          <span>Platform Version: v1.0.0</span>
          <span>Last Updated: {formatDate(new Date())}</span>
          <span className="flex items-center">
            <span className="w-2 h-2 bg-green-500 rounded-full mr-2"></span>
            System Operational
          </span>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
