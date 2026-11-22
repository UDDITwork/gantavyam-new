// config/pickupPods.js
// The pickup points ("pods") the platform serves. The same list lives on the server in
// server/config/pickupPods.js: keep the two in step.
//
// The booth NAME of a pod is stored on every ride, driver queue and driver request, so it must never change.
// An executive (sub-admin) is tied to one pod and only ever sees that pod's operations.

export const PICKUP_PODS = [
  {
    key: 'HK',
    id: 'M-Y-024-GATE1',
    name: 'Hauz Khas Metro Gate No 1',
    displayName: 'Hauz Khas Metro Station - Exit No. 1',
    shortName: 'Hauz Khas',
    boothCode: 'HAUZ',
    latitude: 28.5433,
    longitude: 77.2066,
    lat: 28.5433,
    lng: 77.2066,
    line: 'yellow',
    subType: 'Yellow Line',
    address: 'Hauz Khas Metro Station Gate No 1, Outer Ring Road, Hauz Khas, New Delhi',
    aliases: ['Hauz Khas Metro Station Gate No 1', 'Hauz Khas Metro Station Exit No 1', 'Hauz Khas Metro Station', 'Hauz Khas']
  },
  {
    key: 'PC',
    id: 'M-Y-016',
    name: 'Patel Chowk Metro Station',
    displayName: 'Patel Chowk Metro Station - Exit No. 1',
    shortName: 'Patel Chowk',
    boothCode: 'PATE',
    latitude: 28.622834,
    longitude: 77.214126,
    lat: 28.622834,
    lng: 77.214126,
    line: 'yellow',
    subType: 'Yellow Line',
    address: 'Patel Chowk Metro Station Exit No 1, Sansad Marg, New Delhi',
    aliases: ['Patel Chowk Metro Station Exit No 1', 'Patel Chowk Metro Gate No 1', 'Patel Chowk']
  }
];

// "Hauz Khas  Metro-Gate No.1 " -> "hauz khas metro gate no 1"
export const normalizeBooth = (value) =>
  String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const byNormalizedName = new Map();
PICKUP_PODS.forEach((pod) => {
  [pod.name, pod.displayName, ...pod.aliases].forEach((name) => byNormalizedName.set(normalizeBooth(name), pod));
});

// 'HK' / 'hk' -> the pod, anything else -> null
export const getPodByKey = (key) =>
  key == null ? null : PICKUP_PODS.find((pod) => pod.key === String(key).trim().toUpperCase()) || null;

// The pod a booth name belongs to (exact name, known spelling, or a name containing the locality), else null
export const podForBooth = (booth) => {
  const normalized = normalizeBooth(booth);
  if (!normalized) return null;
  if (byNormalizedName.has(normalized)) return byNormalizedName.get(normalized);
  return PICKUP_PODS.find((pod) => normalized.includes(normalizeBooth(pod.shortName))) || null;
};

// Does this booth name belong to that pod?  (podKey 'all' / empty matches everything)
export const boothInPod = (booth, podKey) => {
  if (!podKey || podKey === 'all') return true;
  const pod = podForBooth(booth);
  return !!pod && pod.key === String(podKey).toUpperCase();
};

// Short label for badges: "Hauz Khas" / "Patel Chowk" (the booth name itself when it is not a known pod)
export const podLabelForBooth = (booth) => {
  const pod = podForBooth(booth);
  return pod ? pod.shortName : booth || '';
};
