// components/admin/PodFilter.js
// Pickup point ("pod") filtering for the admin screens that can show both pods at once (Fleet Manager and Queue
// Management):
//  - usePodFilter(): who is looking (admin or executive) and which pickup point the chips have selected
//  - PodFilterBar:   admins get the "All pickup points | Hauz Khas | Patel Chowk" chips, an executive gets a fixed,
//                    non-interactive "Pickup point: ..." note (the server already limits them to their own pod)
//  - PodBadge:       the small "Hauz Khas" / "Patel Chowk" label shown on every booking, ride, request and driver row
import React, { useState } from 'react';
import { FiMapPin } from 'react-icons/fi';
import { useAdmin } from '../../contexts/AdminContext';
import { PICKUP_PODS, getPodByKey, podForBooth, podLabelForBooth } from '../../config/pickupPods';

// One accent per pod so rows of both pods can be told apart at a glance (whole class names so Tailwind keeps them)
const POD_BADGE_STYLES = {
  HK: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  PC: 'bg-teal-50 text-teal-700 border-teal-200'
};
const UNKNOWN_POD_BADGE_STYLE = 'bg-gray-100 text-gray-600 border-gray-200';

// AdminContext provides isExecutive and assignedPod. Anything missing or undefined means "admin" (sees both pods).
export const usePodFilter = () => {
  const context = useAdmin() || {};
  const [selectedPod, setSelectedPod] = useState('all');

  const executiveFlag = context.isExecutive;
  const isExecutive = typeof executiveFlag === 'function' ? !!executiveFlag() : !!executiveFlag;
  const assignedPod = isExecutive
    ? context.assignedPod ||
      (context.admin && (context.admin.pod || getPodByKey(context.admin.assignedPickupLocation))) ||
      null
    : null;

  return {
    isExecutive,
    assignedPod,
    // An executive only ever receives their own pickup point, so there is nothing for them to filter
    podFilter: isExecutive ? 'all' : selectedPod,
    setPodFilter: setSelectedPod
  };
};

const PodFilterBar = ({ isExecutive = false, assignedPod = null, value = 'all', onChange, className = '' }) => {
  if (isExecutive) {
    if (!assignedPod) return null;
    return (
      <div
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-indigo-100 bg-indigo-50 text-sm text-indigo-800 ${className}`}
      >
        <FiMapPin className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <span>
          Pickup point: <span className="font-semibold">{assignedPod.displayName || assignedPod.name}</span>
        </span>
      </div>
    );
  }

  const options = [{ key: 'all', label: 'All pickup points' }, ...PICKUP_PODS.map((pod) => ({ key: pod.key, label: pod.shortName }))];

  return (
    <div role="group" aria-label="Filter by pickup point" className={`flex flex-wrap items-center gap-2 ${className}`}>
      {options.map((option) => {
        const active = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange && onChange(option.key)}
            className={`px-3 py-1.5 rounded-full border text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-300 ${
              active
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

// Small pod label for a booth name. Renders nothing for an empty booth; an unknown booth shows its own name in grey.
export const PodBadge = ({ booth, className = '' }) => {
  const label = podLabelForBooth(booth);
  if (!label) return null;

  const pod = podForBooth(booth);
  const tone = (pod && POD_BADGE_STYLES[pod.key]) || UNKNOWN_POD_BADGE_STYLE;

  return (
    <span
      title={booth}
      className={`inline-flex items-center max-w-[10rem] px-2 py-0.5 rounded-full border text-xs font-medium leading-4 whitespace-nowrap ${tone} ${className}`}
    >
      <span className="truncate">{label}</span>
    </span>
  );
};

export default PodFilterBar;
