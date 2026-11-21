import React, { useState, useEffect } from 'react';
import { FaChartLine, FaMoneyBillWave, FaPercent, FaReceipt, FaArrowUp, FaArrowDown, FaCalendarDay, FaCalendarWeek, FaCalendarAlt, FaCalendar, FaDownload, FaFilter, FaSpinner, FaCreditCard, FaWallet } from 'react-icons/fa';
import { Line, Pie, Bar } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement
} from 'chart.js';
import { admin as adminAPI } from '../../services/api';

// Register ChartJS components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement
);

const FinancialSummary = ({ rides = [], onRefresh, loading: externalLoading = false }) => {
  const [timeRange, setTimeRange] = useState('today');
  const [loading, setLoading] = useState(false);

  // Date selection mode: 'preset' | 'single' | 'range'
  const [dateMode, setDateMode] = useState('preset');
  const [singleDate, setSingleDate] = useState(new Date().toISOString().split('T')[0]);
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');
  const [activeDateRange, setActiveDateRange] = useState(null); // Tracks which date range is currently active

  const [financialStats, setFinancialStats] = useState({
    totalRevenue: 0,
    driverEarnings: 0,
    platformRevenue: 0,
    totalRides: 0,
    completedRides: 0,
    pendingCollections: 0,
    averageFare: 0,
    // New metrics
    cashPayments: 0,
    onlinePayments: 0,
    cashRides: 0,
    onlineRides: 0,
    netProfit: 0
  });

  const [chartData, setChartData] = useState({
    revenue: null,
    paymentMethods: null,
    hourlyDistribution: null
  });

  const [comparison, setComparison] = useState({
    revenue: { current: 0, previous: 0, change: 0 },
    rides: { current: 0, previous: 0, change: 0 },
    average: { current: 0, previous: 0, change: 0 }
  });

  // Fetch financial data from backend API
  useEffect(() => {
    if (dateMode === 'preset') {
      fetchFinancialData();
    }
  }, [timeRange, dateMode]);

  // Fetch data for custom date range
  const fetchDataForCustomRange = async (startDate, endDate) => {
    try {
      setLoading(true);
      console.log('📊 [FinancialSummary] Fetching data for custom range:', { startDate, endDate });

      setActiveDateRange({ startDate, endDate });

      const [summaryRes, trendsRes] = await Promise.all([
        adminAPI.getFinancialSummary({ startDate, endDate }).catch(err => {
          console.error('📊 [FinancialSummary] Error fetching summary:', err);
          return { success: false };
        }),
        adminAPI.getRevenueTrends({ startDate, endDate, groupBy: 'day' }).catch(err => {
          console.error('📊 [FinancialSummary] Error fetching trends:', err);
          return { success: false };
        })
      ]);

      processApiResponses(summaryRes, trendsRes);
    } catch (error) {
      console.error('📊 [FinancialSummary] Error:', error);
      calculateFinancialStatsFromRides();
      generateChartData();
    } finally {
      setLoading(false);
    }
  };

  // Fetch for single date
  const fetchDataForSingleDate = (date) => {
    const startDate = `${date}T00:00:00`;
    const endDate = `${date}T23:59:59`;
    fetchDataForCustomRange(startDate, endDate);
  };

  // Fetch for date range
  const fetchDataForDateRange = () => {
    if (!customStartDate || !customEndDate) {
      alert('Please select both start and end dates');
      return;
    }
    const startDate = `${customStartDate}T00:00:00`;
    const endDate = `${customEndDate}T23:59:59`;
    fetchDataForCustomRange(startDate, endDate);
  };

  const fetchFinancialData = async () => {
    try {
      setLoading(true);
      console.log('📊 [FinancialSummary] Fetching financial data for period:', timeRange);

      setActiveDateRange(null); // Clear custom range when using preset

      // Map timeRange to API period parameter
      const periodMap = {
        'today': 'today',
        'week': 'week',
        'month': 'month',
        'year': 'year'
      };

      const [summaryRes, trendsRes] = await Promise.all([
        adminAPI.getFinancialSummary({ period: periodMap[timeRange] || 'today' }).catch(err => {
          console.error('📊 [FinancialSummary] Error fetching summary:', err);
          return { success: false };
        }),
        adminAPI.getRevenueTrends({ period: periodMap[timeRange] || 'week', groupBy: 'day' }).catch(err => {
          console.error('📊 [FinancialSummary] Error fetching trends:', err);
          return { success: false };
        })
      ]);

      processApiResponses(summaryRes, trendsRes);
    } catch (error) {
      console.error('📊 [FinancialSummary] Error fetching financial data:', error);
      // Fallback to client-side calculation if API fails
      calculateFinancialStatsFromRides();
      generateChartData();
    } finally {
      setLoading(false);
    }
  };

  // Process API responses (reusable for both preset and custom date ranges)
  const processApiResponses = (summaryRes, trendsRes) => {
    console.log('📊 [FinancialSummary] Summary response:', summaryRes);
    console.log('📊 [FinancialSummary] Trends response:', trendsRes);

    if (summaryRes.success && summaryRes.data) {
      const data = summaryRes.data;
      setFinancialStats({
        totalRevenue: data.totalRevenue || 0,
        driverEarnings: data.driverEarnings || 0,
        platformRevenue: data.platformRevenue || data.platformEarnings || 0,
        totalRides: data.totalRides || 0,
        completedRides: data.completedRides || 0,
        pendingCollections: data.pendingCollections || 0,
        averageFare: data.averageFare || 0,
        // New metrics
        cashPayments: data.cashPayments || 0,
        onlinePayments: data.onlinePayments || 0,
        cashRides: data.cashRides || 0,
        onlineRides: data.onlineRides || 0,
        netProfit: data.netProfit || 0
      });

      // Set comparison data if available
      if (data.comparison) {
        setComparison({
          revenue: {
            current: data.totalRevenue || 0,
            previous: data.comparison.previousRevenue || 0,
            change: data.comparison.revenueChange || 0
          },
          rides: {
            current: data.totalRides || 0,
            previous: data.comparison.previousRides || 0,
            change: data.comparison.ridesChange || 0
          },
          average: {
            current: data.averageFare || 0,
            previous: data.comparison.previousAvgFare || 0,
            change: data.comparison.avgFareChange || 0
          }
        });
      }
    }

    // Generate chart data from trends
    if (trendsRes.success && trendsRes.data) {
      const trends = Array.isArray(trendsRes.data) ? trendsRes.data : (trendsRes.data.trends || []);
      generateChartDataFromTrends(trends);
    } else {
      // Fallback: generate empty chart data
      generateChartData();
    }
  };

  // Generate chart data from API trends response
  // FIX: Properly handle date format - backend sends "2026-02-02", we need to display "Feb 2"
  const generateChartDataFromTrends = (trends) => {
    console.log('📊 [FinancialSummary] Generating chart from trends:', trends);

    if (!trends || trends.length === 0) {
      console.log('📊 [FinancialSummary] No trends data, generating empty chart');
      // Generate empty data based on current timeRange
      const emptyChart = generateEmptyChartForTimeRange();
      setChartData({
        revenue: emptyChart,
        paymentMethods: generatePaymentMethodsChart(),
        hourlyDistribution: null
      });
      return;
    }

    // Parse and format the dates from API response
    // Backend sends dates like "2026-02-02" or with _id object
    const formattedTrends = trends.map(item => {
      let dateStr = item.date;

      // Handle _id object format from MongoDB aggregation
      if (item._id && typeof item._id === 'object') {
        if (item._id.day && item._id.month && item._id.year) {
          dateStr = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
        }
      }

      // Parse the date and format for display
      const date = new Date(dateStr);
      const displayDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      return {
        rawDate: dateStr,
        displayDate: displayDate,
        revenue: item.revenue || 0,
        rides: item.rides || item.completedRides || 0
      };
    });

    // Sort by date
    formattedTrends.sort((a, b) => new Date(a.rawDate) - new Date(b.rawDate));

    console.log('📊 [FinancialSummary] Formatted trends:', formattedTrends);

    // Use the API data directly - don't generate hardcoded labels
    const labels = formattedTrends.map(item => item.displayDate);
    const revenueData = formattedTrends.map(item => item.revenue);

    const revenueChart = {
      labels: labels,
      datasets: [{
        label: 'Daily Revenue',
        data: revenueData,
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.3
      }]
    };

    // Payment methods chart
    const paymentChart = generatePaymentMethodsChart();

    setChartData({
      revenue: revenueChart,
      paymentMethods: paymentChart,
      hourlyDistribution: null
    });
  };

  // Generate empty chart data based on timeRange
  const generateEmptyChartForTimeRange = () => {
    const labels = [];
    const now = new Date();

    let daysToShow;
    switch (dateMode === 'preset' ? timeRange : 'custom') {
      case 'today':
        daysToShow = 1;
        break;
      case 'week':
        daysToShow = 7;
        break;
      case 'month':
        daysToShow = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        break;
      case 'year':
        daysToShow = 30; // Show last 30 days for yearly view
        break;
      default:
        daysToShow = 7;
    }

    for (let i = daysToShow - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      labels.push(date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
    }

    return {
      labels,
      datasets: [{
        label: 'Daily Revenue',
        data: new Array(labels.length).fill(0),
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.3
      }]
    };
  };

  // Generate payment methods pie chart from financialStats
  const generatePaymentMethodsChart = () => {
    // Use rides array as fallback for payment methods
    const paymentMethods = {};
    rides.forEach(ride => {
      const method = ride.paymentMethod || 'cash';
      paymentMethods[method] = (paymentMethods[method] || 0) + 1;
    });

    return Object.keys(paymentMethods).length > 0 ? {
      labels: Object.keys(paymentMethods),
      datasets: [{
        data: Object.values(paymentMethods),
        backgroundColor: [
          'rgba(34, 197, 94, 0.8)',
          'rgba(59, 130, 246, 0.8)',
          'rgba(168, 85, 247, 0.8)',
          'rgba(251, 146, 60, 0.8)'
        ],
        borderWidth: 0
      }]
    } : null;
  };

  // Fallback: Calculate stats from rides array if API fails
  const calculateFinancialStatsFromRides = () => {
    let stats = {
      totalRevenue: 0,
      driverEarnings: 0,
      platformRevenue: 0,
      totalRides: 0,
      completedRides: 0,
      pendingCollections: 0,
      averageFare: 0,
      // New metrics
      cashPayments: 0,
      onlinePayments: 0,
      cashRides: 0,
      onlineRides: 0,
      netProfit: 0
    };

    const filteredRides = filterRidesByTimeRange(rides);

    filteredRides.forEach(ride => {
      const driverFare = ride.driverFare || ride.fare || 0;
      const customerFare = ride.customerFare || ride.estimatedFare || 0;
      // Platform earns the spread — no commission, no GST
      const platformEarning = ride.platformEarning != null
        ? ride.platformEarning
        : Math.max(0, customerFare - driverFare);

      stats.totalRevenue += customerFare;
      stats.driverEarnings += driverFare;
      stats.platformRevenue += platformEarning;
      stats.totalRides += 1;

      if (ride.status === 'completed') {
        stats.completedRides += 1;
      }

      if (ride.paymentStatus !== 'collected') {
        stats.pendingCollections += customerFare;
      }

      // Track payment methods
      const paymentMethod = (ride.paymentMethod || 'cash').toLowerCase();
      if (paymentMethod === 'cash') {
        stats.cashPayments += customerFare;
        stats.cashRides += 1;
      } else {
        stats.onlinePayments += customerFare;
        stats.onlineRides += 1;
      }
    });

    if (stats.totalRides > 0) {
      stats.averageFare = Math.round(stats.totalRevenue / stats.totalRides);
    }

    // Net Profit = Platform Revenue (the spread between customer and driver)
    stats.netProfit = stats.platformRevenue;

    setFinancialStats(stats);
  };

  const filterRidesByTimeRange = (rides) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    return rides.filter(ride => {
      const rideDate = new Date(ride.createdAt || ride.bookingTime);

      switch (timeRange) {
        case 'today':
          return rideDate >= today;
        case 'week':
          const weekAgo = new Date(today);
          weekAgo.setDate(weekAgo.getDate() - 7);
          return rideDate >= weekAgo;
        case 'month':
          const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
          return rideDate >= monthStart;
        case 'year':
          // Financial Year: April 1 to March 31
          const currentMonth = now.getMonth();
          const fyYear = currentMonth >= 3 ? now.getFullYear() : now.getFullYear() - 1;
          const fyStart = new Date(fyYear, 3, 1); // April 1st
          return rideDate >= fyStart;
        default:
          return true;
      }
    });
  };

  const generateChartData = () => {
    const filteredRides = filterRidesByTimeRange(rides);

    // Revenue trend chart
    const revenueByDay = {};
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      last7Days.push(dateStr);
      revenueByDay[dateStr] = 0;
    }

    filteredRides.forEach(ride => {
      const date = new Date(ride.createdAt || ride.bookingTime);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (revenueByDay[dateStr] !== undefined) {
        revenueByDay[dateStr] += ride.customerFare || ride.estimatedFare || 0;
      }
    });

    const revenueChart = {
      labels: last7Days,
      datasets: [{
        label: 'Daily Revenue',
        data: last7Days.map(day => revenueByDay[day]),
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        tension: 0.3
      }]
    };

    // Payment methods pie chart
    const paymentMethods = {};
    filteredRides.forEach(ride => {
      const method = ride.paymentMethod || 'cash';
      paymentMethods[method] = (paymentMethods[method] || 0) + 1;
    });

    const paymentChart = {
      labels: Object.keys(paymentMethods),
      datasets: [{
        data: Object.values(paymentMethods),
        backgroundColor: [
          'rgba(34, 197, 94, 0.8)',
          'rgba(59, 130, 246, 0.8)',
          'rgba(168, 85, 247, 0.8)',
          'rgba(251, 146, 60, 0.8)'
        ],
        borderWidth: 0
      }]
    };

    // Hourly distribution
    const hourlyData = new Array(24).fill(0);
    filteredRides.forEach(ride => {
      const hour = new Date(ride.createdAt || ride.bookingTime).getHours();
      hourlyData[hour]++;
    });

    const hourlyChart = {
      labels: Array.from({length: 24}, (_, i) => `${i}:00`),
      datasets: [{
        label: 'Rides per Hour',
        data: hourlyData,
        backgroundColor: 'rgba(34, 197, 94, 0.6)',
        borderColor: 'rgb(34, 197, 94)',
        borderWidth: 1
      }]
    };

    setChartData({
      revenue: revenueChart,
      paymentMethods: paymentChart,
      hourlyDistribution: hourlyChart
    });
  };

  const calculateComparison = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    let currentPeriodRides = [];
    let previousPeriodRides = [];

    if (timeRange === 'today') {
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      currentPeriodRides = rides.filter(r => new Date(r.createdAt) >= today);
      previousPeriodRides = rides.filter(r => {
        const rideDate = new Date(r.createdAt);
        return rideDate >= yesterday && rideDate < today;
      });
    } else if (timeRange === 'week') {
      const weekAgo = new Date(today);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const twoWeeksAgo = new Date(today);
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

      currentPeriodRides = rides.filter(r => new Date(r.createdAt) >= weekAgo);
      previousPeriodRides = rides.filter(r => {
        const rideDate = new Date(r.createdAt);
        return rideDate >= twoWeeksAgo && rideDate < weekAgo;
      });
    }

    const currentRevenue = currentPeriodRides.reduce((sum, r) => sum + (r.customerFare || r.estimatedFare || 0), 0);
    const previousRevenue = previousPeriodRides.reduce((sum, r) => sum + (r.customerFare || r.estimatedFare || 0), 0);

    const currentAvg = currentPeriodRides.length > 0 ? currentRevenue / currentPeriodRides.length : 0;
    const previousAvg = previousPeriodRides.length > 0 ? previousRevenue / previousPeriodRides.length : 0;

    setComparison({
      revenue: {
        current: currentRevenue,
        previous: previousRevenue,
        change: previousRevenue > 0 ? ((currentRevenue - previousRevenue) / previousRevenue * 100).toFixed(1) : 0
      },
      rides: {
        current: currentPeriodRides.length,
        previous: previousPeriodRides.length,
        change: previousPeriodRides.length > 0 ? ((currentPeriodRides.length - previousPeriodRides.length) / previousPeriodRides.length * 100).toFixed(1) : 0
      },
      average: {
        current: Math.round(currentAvg),
        previous: Math.round(previousAvg),
        change: previousAvg > 0 ? ((currentAvg - previousAvg) / previousAvg * 100).toFixed(1) : 0
      }
    });
  };

  const handleExport = () => {
    // Generate CSV data
    const csvContent = generateCSVReport();
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `financial-report-${timeRange}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const generateCSVReport = () => {
    const filteredRides = filterRidesByTimeRange(rides);
    let csv = 'Ride ID,Date,Customer,Driver,Vehicle Type,Distance,Driver Fare,Customer Total,Platform Earning,Payment Status\n';

    filteredRides.forEach(ride => {
      const driverFare = ride.driverFare || ride.fare || 0;
      const customerTotal = ride.customerFare || ride.estimatedFare || 0;
      const platformEarning = ride.platformEarning != null
        ? ride.platformEarning
        : Math.max(0, customerTotal - driverFare);

      csv += `${ride.rideId || ride._id},${new Date(ride.createdAt).toLocaleString()},${ride.userName || 'N/A'},${ride.driverName || 'N/A'},${ride.vehicleType || 'N/A'},${ride.distance || 0},${driverFare},${customerTotal},${platformEarning},${ride.paymentStatus || 'pending'}\n`;
    });

    return csv;
  };

  return (
    <div className="space-y-6">
      {/* Header with Time Range Selector */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FaChartLine className="text-blue-600" />
            Financial Dashboard
          </h2>

          <div className="flex items-center gap-3">
            <button
              onClick={handleExport}
              className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-1.5 text-sm font-medium"
            >
              <FaDownload size={14} />
              Export
            </button>

            <button
              onClick={() => {
                if (dateMode === 'preset') {
                  fetchFinancialData();
                } else if (dateMode === 'single') {
                  fetchDataForSingleDate(singleDate);
                } else if (dateMode === 'range' && customStartDate && customEndDate) {
                  fetchDataForDateRange();
                }
                if (onRefresh) onRefresh();
              }}
              disabled={loading || externalLoading}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5 text-sm font-medium disabled:opacity-50"
            >
              {loading ? <FaSpinner className="animate-spin" size={14} /> : <FaFilter size={14} />}
              Refresh
            </button>
          </div>
        </div>

        {/* Date Selection Mode Toggle */}
        <div className="mt-4 pt-4 border-t border-gray-200">
          <div className="flex flex-wrap items-center gap-4">
            {/* Mode Toggle */}
            <div className="flex bg-gray-100 rounded-lg p-1">
              <button
                onClick={() => setDateMode('preset')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  dateMode === 'preset' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                Preset Filters
              </button>
              <button
                onClick={() => setDateMode('single')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  dateMode === 'single' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                Single Date
              </button>
              <button
                onClick={() => setDateMode('range')}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${
                  dateMode === 'range' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                Date Range
              </button>
            </div>

            {/* Preset Filters */}
            {dateMode === 'preset' && (
              <div className="flex bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setTimeRange('today')}
                  className={`px-3 py-1.5 rounded flex items-center gap-1.5 text-sm font-medium transition-colors ${
                    timeRange === 'today' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  <FaCalendarDay size={14} />
                  Daily
                </button>
                <button
                  onClick={() => setTimeRange('week')}
                  className={`px-3 py-1.5 rounded flex items-center gap-1.5 text-sm font-medium transition-colors ${
                    timeRange === 'week' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  <FaCalendarWeek size={14} />
                  Weekly
                </button>
                <button
                  onClick={() => setTimeRange('month')}
                  className={`px-3 py-1.5 rounded flex items-center gap-1.5 text-sm font-medium transition-colors ${
                    timeRange === 'month' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  <FaCalendarAlt size={14} />
                  Monthly
                </button>
                <button
                  onClick={() => setTimeRange('year')}
                  className={`px-3 py-1.5 rounded flex items-center gap-1.5 text-sm font-medium transition-colors ${
                    timeRange === 'year' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  <FaCalendar size={14} />
                  FY Yearly
                </button>
              </div>
            )}

            {/* Single Date Picker */}
            {dateMode === 'single' && (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={singleDate}
                  onChange={(e) => setSingleDate(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => fetchDataForSingleDate(singleDate)}
                  disabled={loading}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? <FaSpinner className="animate-spin" /> : 'View'}
                </button>
              </div>
            )}

            {/* Date Range Picker */}
            {dateMode === 'range' && (
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Start Date"
                />
                <span className="text-gray-500">to</span>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  className="px-3 py-1.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="End Date"
                />
                <button
                  onClick={fetchDataForDateRange}
                  disabled={loading || !customStartDate || !customEndDate}
                  className="px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? <FaSpinner className="animate-spin" /> : 'Apply'}
                </button>
              </div>
            )}
          </div>

          {/* Active Date Range Display */}
          {activeDateRange && (
            <div className="mt-2 text-sm text-gray-600">
              Showing data from <span className="font-medium">{new Date(activeDateRange.startDate).toLocaleDateString()}</span> to <span className="font-medium">{new Date(activeDateRange.endDate).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      </div>

      {/* Key Metrics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Revenue Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <FaMoneyBillWave className="text-green-600 text-xl" />
            </div>
            {comparison.revenue.change !== 0 && (
              <div className={`flex items-center gap-1 text-sm font-medium ${
                comparison.revenue.change > 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {comparison.revenue.change > 0 ? <FaArrowUp size={12} /> : <FaArrowDown size={12} />}
                {Math.abs(comparison.revenue.change)}%
              </div>
            )}
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.totalRevenue.toLocaleString()}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Total Revenue</div>
          <div className="text-xs text-gray-500 mt-2">
            {financialStats.completedRides} completed rides
          </div>
        </div>

        {/* Platform Earnings Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-blue-100 rounded-lg">
              <FaPercent className="text-blue-600 text-xl" />
            </div>
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.platformRevenue.toLocaleString()}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Platform Earnings</div>
          <div className="text-xs text-gray-500 mt-2">
            Spread: Customer − Driver
          </div>
        </div>

        {/* Average Fare Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-purple-100 rounded-lg">
              <FaReceipt className="text-purple-600 text-xl" />
            </div>
            {comparison.average.change !== 0 && (
              <div className={`flex items-center gap-1 text-sm font-medium ${
                comparison.average.change > 0 ? 'text-green-600' : 'text-red-600'
              }`}>
                {comparison.average.change > 0 ? <FaArrowUp size={12} /> : <FaArrowDown size={12} />}
                {Math.abs(comparison.average.change)}%
              </div>
            )}
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.averageFare}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Average Fare</div>
          <div className="text-xs text-gray-500 mt-2">
            Per ride average
          </div>
        </div>

        {/* Pending Collections Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <FaMoneyBillWave className="text-yellow-600 text-xl" />
            </div>
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.pendingCollections.toLocaleString()}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Pending Collections</div>
          <div className="text-xs text-gray-500 mt-2">
            Awaiting payment
          </div>
        </div>
      </div>

      {/* Payment Methods & Profit Cards - Second Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Cash Payments Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-green-100 rounded-lg">
              <FaWallet className="text-green-600 text-xl" />
            </div>
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.cashPayments.toLocaleString()}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Cash Payments</div>
          <div className="text-xs text-gray-500 mt-2">
            {financialStats.cashRides} rides via cash
          </div>
        </div>

        {/* Online Payments Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-indigo-100 rounded-lg">
              <FaCreditCard className="text-indigo-600 text-xl" />
            </div>
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.onlinePayments.toLocaleString()}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Online Payments</div>
          <div className="text-xs text-gray-500 mt-2">
            {financialStats.onlineRides} rides via UPI/Card
          </div>
        </div>

        {/* Platform Spread Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-orange-100 rounded-lg">
              <FaChartLine className="text-orange-600 text-xl" />
            </div>
          </div>
          <div className="text-2xl font-bold text-gray-800">
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.platformRevenue.toLocaleString()}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Platform Spread</div>
          <div className="text-xs text-gray-500 mt-2">
            Customer − Driver earnings
          </div>
        </div>

        {/* Net Profit Card */}
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="p-2 bg-emerald-100 rounded-lg">
              <FaChartLine className="text-emerald-600 text-xl" />
            </div>
          </div>
          <div className={`text-2xl font-bold ${financialStats.netProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {loading ? <FaSpinner className="animate-spin text-gray-400" /> : `₹${financialStats.netProfit.toLocaleString()}`}
          </div>
          <div className="text-sm text-gray-600 mt-1">Net Profit</div>
          <div className="text-xs text-gray-500 mt-2">
            = Platform Spread (Customer − Driver)
          </div>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue Trend Chart */}
        {chartData.revenue && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Revenue Trend</h3>
            <div className="h-64">
              <Line
                data={chartData.revenue}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: { display: false }
                  },
                  scales: {
                    y: {
                      beginAtZero: true,
                      ticks: {
                        callback: (value) => `₹${value}`
                      }
                    }
                  }
                }}
              />
            </div>
          </div>
        )}

        {/* Payment Methods Distribution */}
        {chartData.paymentMethods && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Payment Methods</h3>
            <div className="h-64">
              <Pie
                data={chartData.paymentMethods}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: {
                      position: 'bottom'
                    }
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Hourly Distribution */}
      {chartData.hourlyDistribution && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">Hourly Ride Distribution</h3>
          <div className="h-64">
            <Bar
              data={chartData.hourlyDistribution}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { display: false }
                },
                scales: {
                  y: {
                    beginAtZero: true,
                    ticks: {
                      stepSize: 1
                    }
                  }
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Detailed Breakdown */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Financial Breakdown</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 uppercase">Earnings</h4>
            <div className="space-y-2">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Driver Earnings</span>
                <span className="text-sm font-semibold">₹{financialStats.driverEarnings.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Platform Revenue</span>
                <span className="text-sm font-semibold">₹{financialStats.platformRevenue.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 font-semibold">
                <span className="text-sm">Total Revenue</span>
                <span className="text-sm text-green-600">₹{financialStats.totalRevenue.toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 uppercase">Platform Breakdown</h4>
            <div className="space-y-2">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Total Revenue</span>
                <span className="text-sm font-semibold">₹{financialStats.totalRevenue.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Driver Earnings</span>
                <span className="text-sm font-semibold text-red-600">-₹{financialStats.driverEarnings.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 font-semibold">
                <span className="text-sm">Platform Spread</span>
                <span className="text-sm text-blue-600">₹{financialStats.platformRevenue.toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 uppercase">Ride Statistics</h4>
            <div className="space-y-2">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Total Rides</span>
                <span className="text-sm font-semibold">{financialStats.totalRides}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Completed</span>
                <span className="text-sm font-semibold">{financialStats.completedRides}</span>
              </div>
              <div className="flex justify-between items-center py-2 font-semibold">
                <span className="text-sm">Completion Rate</span>
                <span className="text-sm text-green-600">
                  {financialStats.totalRides > 0
                    ? Math.round(financialStats.completedRides / financialStats.totalRides * 100)
                    : 0}%
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Payment Methods Breakdown - Second Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-200">
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 uppercase">Payment Methods</h4>
            <div className="space-y-2">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Cash Payments</span>
                <span className="text-sm font-semibold">₹{financialStats.cashPayments.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Online Payments</span>
                <span className="text-sm font-semibold">₹{financialStats.onlinePayments.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 font-semibold">
                <span className="text-sm">Total Collected</span>
                <span className="text-sm text-green-600">₹{(financialStats.cashPayments + financialStats.onlinePayments).toLocaleString()}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 uppercase">Payment Ride Count</h4>
            <div className="space-y-2">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Cash Rides</span>
                <span className="text-sm font-semibold">{financialStats.cashRides}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Online Rides</span>
                <span className="text-sm font-semibold">{financialStats.onlineRides}</span>
              </div>
              <div className="flex justify-between items-center py-2 font-semibold">
                <span className="text-sm">Total Rides</span>
                <span className="text-sm text-blue-600">{financialStats.cashRides + financialStats.onlineRides}</span>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-700 uppercase">Profit Summary</h4>
            <div className="space-y-2">
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Total Revenue</span>
                <span className="text-sm font-semibold">₹{financialStats.totalRevenue.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 border-b border-gray-100">
                <span className="text-sm text-gray-600">Driver Earnings</span>
                <span className="text-sm font-semibold text-red-600">-₹{financialStats.driverEarnings.toLocaleString()}</span>
              </div>
              <div className="flex justify-between items-center py-2 font-semibold">
                <span className="text-sm">Net Profit (Spread)</span>
                <span className={`text-sm ${financialStats.netProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  ₹{financialStats.netProfit.toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FinancialSummary;