import React, { createContext, useContext, useReducer } from 'react';
import { users, admin } from '../services/api';

// Initial state
const initialState = {
  fareEstimates: null,
  loading: false,
  error: null,
  lastCalculation: null,
  fareBreakdown: null,
  customFare: null
};

// Action types
const FARE_ACTIONS = {
  SET_LOADING: 'SET_LOADING',
  SET_FARE_ESTIMATES: 'SET_FARE_ESTIMATES',
  SET_ERROR: 'SET_ERROR',
  SET_FARE_BREAKDOWN: 'SET_FARE_BREAKDOWN',
  SET_CUSTOM_FARE: 'SET_CUSTOM_FARE',
  CLEAR_ERROR: 'CLEAR_ERROR',
  RESET_FARE: 'RESET_FARE'
};

// Reducer
const fareReducer = (state, action) => {
  switch (action.type) {
    case FARE_ACTIONS.SET_LOADING:
      return {
        ...state,
        loading: action.payload
      };
    
    case FARE_ACTIONS.SET_FARE_ESTIMATES:
      return {
        ...state,
        fareEstimates: action.payload,
        lastCalculation: new Date(),
        loading: false,
        error: null
      };
    
    case FARE_ACTIONS.SET_ERROR:
      return {
        ...state,
        error: action.payload,
        loading: false
      };
    
    case FARE_ACTIONS.SET_FARE_BREAKDOWN:
      return {
        ...state,
        fareBreakdown: action.payload
      };
    
    case FARE_ACTIONS.SET_CUSTOM_FARE:
      return {
        ...state,
        customFare: action.payload
      };
    
    case FARE_ACTIONS.CLEAR_ERROR:
      return {
        ...state,
        error: null
      };
    
    case FARE_ACTIONS.RESET_FARE:
      return {
        ...initialState
      };
    
    default:
      return state;
  }
};

// Create context
const FareContext = createContext();

// Provider component
export const FareProvider = ({ children }) => {
  const [state, dispatch] = useReducer(fareReducer, initialState);

  // Actions
  const setLoading = (loading) => {
    dispatch({ type: FARE_ACTIONS.SET_LOADING, payload: loading });
  };

  const setFareEstimates = (estimates) => {
    dispatch({ type: FARE_ACTIONS.SET_FARE_ESTIMATES, payload: estimates });
  };

  const setError = (error) => {
    dispatch({ type: FARE_ACTIONS.SET_ERROR, payload: error });
  };

  const clearError = () => {
    dispatch({ type: FARE_ACTIONS.CLEAR_ERROR });
  };

  const setFareBreakdown = (breakdown) => {
    dispatch({ type: FARE_ACTIONS.SET_FARE_BREAKDOWN, payload: breakdown });
  };

  const setCustomFare = (fare) => {
    dispatch({ type: FARE_ACTIONS.SET_CUSTOM_FARE, payload: fare });
  };

  const resetFare = () => {
    dispatch({ type: FARE_ACTIONS.RESET_FARE });
  };

  // Calculate fare estimates
  const calculateFareEstimates = async (pickupLocation, dropLocation) => {
    setLoading(true);
    clearError();
    
    try {
      // Convert the pickupLocation and dropLocation to the format expected by the API
      const fareData = {
        pickupLat: pickupLocation.lat,
        pickupLng: pickupLocation.lng,
        dropLat: dropLocation.lat,
        dropLng: dropLocation.lng,
        pickupStation: pickupLocation.address
      };
      
      // Check if we're in admin context by looking at the current path
      const isAdminContext = window.location.pathname.includes('/admin');
      
      const response = isAdminContext 
        ? await admin.getFareEstimate(fareData)
        : await users.getFareEstimate(fareData);
      
      if (response.success) {
        const estimates = response;
        setFareEstimates(estimates);
        
        // Generate fare breakdown for each vehicle type
        const breakdown = {
          bike: generateFareBreakdown(estimates.estimates?.bike, 'bike'),
          auto: generateFareBreakdown(estimates.estimates?.auto, 'auto'),
          car: generateFareBreakdown(estimates.estimates?.car, 'car')
        };
        setFareBreakdown(breakdown);
        
        return estimates;
      } else {
        setError('Failed to calculate fare');
      }
    } catch (error) {
      setError(error.response?.data?.message || 'Error calculating fare');
      console.error('Error calculating fare:', error);
    } finally {
      setLoading(false);
    }
  };

  // Generate detailed fare breakdown — new piecewise formula model
  // No commission, no GST, no platform fee, no taxes — spread is built into formulas
  const generateFareBreakdown = (estimates, vehicleType) => {
    if (!estimates) return null;

    const driverFare = estimates.driverFare || 0;
    const customerTotalFare = estimates.customerTotalFare || estimates.totalFare || 0;
    const platformEarning = estimates.platformEarning != null
      ? estimates.platformEarning
      : Math.max(0, customerTotalFare - driverFare);
    const isNightCharge = estimates.isNightCharge || false;
    const nightChargeUserAmount = estimates.nightChargeUserAmount || 0;
    const nightChargeDriverAmount = estimates.nightChargeDriverAmount || 0;

    const breakdown = [
      { label: 'Driver Fare', amount: driverFare },
      { label: 'Platform Spread', amount: platformEarning }
    ];

    if (isNightCharge) {
      const userPct = estimates.nightChargeUserPercentage ?? 30;
      const driverPct = estimates.nightChargeDriverPercentage ?? 25;
      breakdown.push({ label: `Night Charge (User +${userPct}%)`, amount: nightChargeUserAmount });
      breakdown.push({ label: `Night Charge (Driver +${driverPct}%)`, amount: nightChargeDriverAmount });
    }

    return {
      vehicleType,
      driverFare,
      customerTotalFare,
      platformEarning,
      isNightCharge,
      nightChargeUserAmount,
      nightChargeDriverAmount,
      totalFare: customerTotalFare,
      breakdown
    };
  };

  // Apply custom fare adjustment
  const applyCustomFare = (vehicleType, newFare, reason = '') => {
    const customFareData = {
      vehicleType,
      originalFare: state.fareEstimates?.estimates?.[vehicleType]?.totalFare || 0,
      customFare: newFare,
      adjustment: newFare - (state.fareEstimates?.estimates?.[vehicleType]?.totalFare || 0),
      reason,
      appliedAt: new Date(),
      appliedBy: 'admin' // Can be dynamic based on logged-in user
    };
    
    setCustomFare(customFareData);
    
    // Update fare estimates with custom fare
    if (state.fareEstimates && state.fareEstimates.estimates && state.fareEstimates.estimates[vehicleType]) {
      const updatedEstimates = {
        ...state.fareEstimates,
        estimates: {
          ...state.fareEstimates.estimates,
          [vehicleType]: {
            ...state.fareEstimates.estimates[vehicleType],
            totalFare: newFare,
            isCustom: true
          }
        }
      };
      setFareEstimates(updatedEstimates);
    }
    
    return customFareData;
  };

  // Get fare for specific vehicle type
  const getFareForVehicle = (vehicleType) => {
    if (state.customFare && state.customFare.vehicleType === vehicleType) {
      return state.customFare.customFare;
    }
    return state.fareEstimates?.estimates?.[vehicleType]?.totalFare || 0;
  };

  // Check if fare is custom
  const isCustomFare = (vehicleType) => {
    return state.fareEstimates?.estimates?.[vehicleType]?.isCustom || false;
  };

  const value = {
    ...state,
    actions: {
      calculateFareEstimates,
      applyCustomFare,
      getFareForVehicle,
      isCustomFare,
      setCustomFare,
      clearError,
      resetFare
    }
  };

  return (
    <FareContext.Provider value={value}>
      {children}
    </FareContext.Provider>
  );
};

// Custom hook to use fare context
export const useFare = () => {
  const context = useContext(FareContext);
  if (!context) {
    throw new Error('useFare must be used within a FareProvider');
  }
  return context;
};

export default FareContext;