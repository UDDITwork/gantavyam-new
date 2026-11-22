// Fixed pickup location configuration
// The rider and driver apps still use the single Hauz Khas Metro Station Gate No 1 below.
// The admin Manual Booking page can work with every pickup point (pod): see getPickupLocationForPod at the end.

import { getPodByKey } from './pickupPods';

export const FIXED_PICKUP_LOCATION = {
  id: 'M-Y-024-GATE1', // Modified ID to indicate Gate 1
  name: 'Hauz Khas Metro Gate No 1',
  type: 'metro',
  subType: 'Yellow Line',
  address: 'Hauz Khas Metro Station Gate No 1, Outer Ring Road, Hauz Khas, New Delhi',
  lat: 28.5433, // Coordinates from existing data, will be refined if needed
  lng: 77.2066,
  line: 'yellow',
  isActive: true,
  priority: 10, // Highest priority
  metadata: {
    description: 'Fixed pickup location - Hauz Khas Metro Station Gate No 1',
    facilities: ['parking', 'waiting_area'],
    gateNumber: 1,
    googleMapsUrl: 'https://maps.app.goo.gl/eUY4RznKCNvTuciTA'
  }
};

// Helper function to get the fixed pickup location
export const getFixedPickupLocation = () => {
  return FIXED_PICKUP_LOCATION;
};

// Message to display to users about the fixed pickup location
export const FIXED_PICKUP_MESSAGE = 'Pickup is currently available only from Hauz Khas Metro Station Gate No 1';

// A pickup point (see config/pickupPods.js) in the same shape as FIXED_PICKUP_LOCATION, plus the pod's own labels
// (key, displayName, shortName, boothCode) and boothName (the booth name stored on rides).
// For the Hauz Khas pod every field of FIXED_PICKUP_LOCATION is kept as it is. An unknown pod gives FIXED_PICKUP_LOCATION.
// The same object is returned for the same pod, so it is safe to use in hook dependency lists.
const pickupLocationByPodKey = {};

export const getPickupLocationForPod = (podOrKey) => {
  const pod = getPodByKey(podOrKey && typeof podOrKey === 'object' ? podOrKey.key : podOrKey);
  if (!pod) return FIXED_PICKUP_LOCATION;

  if (!pickupLocationByPodKey[pod.key]) {
    const labels = {
      key: pod.key,
      displayName: pod.displayName,
      shortName: pod.shortName,
      boothCode: pod.boothCode,
      boothName: pod.name
    };

    pickupLocationByPodKey[pod.key] = pod.name === FIXED_PICKUP_LOCATION.name
      ? { ...FIXED_PICKUP_LOCATION, ...labels }
      : {
          id: pod.id,
          name: pod.name,
          type: 'metro',
          subType: pod.subType,
          address: pod.address,
          lat: pod.lat,
          lng: pod.lng,
          line: pod.line,
          isActive: true,
          priority: 10,
          metadata: {
            description: `Pickup location - ${pod.displayName}`,
            facilities: ['parking', 'waiting_area'],
            gateNumber: 1
          },
          ...labels
        };
  }

  return pickupLocationByPodKey[pod.key];
};