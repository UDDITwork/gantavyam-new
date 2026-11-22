// config/pickupPods.js
// The pickup points ("pods") the platform serves. Every ride, driver queue and driver request carries the
// booth name of its pod, so the NAME of a pod must never change: thousands of stored rides use it.
// An executive (sub-admin) is tied to exactly one pod and only ever sees that pod's operations.

const PODS = [
  {
    key: 'HK',
    name: 'Hauz Khas Metro Gate No 1',
    displayName: 'Hauz Khas Metro Station - Exit No. 1',
    shortName: 'Hauz Khas',
    pickupLocationId: 'M-Y-024-GATE1',
    boothCode: 'HAUZ',
    latitude: 28.5433,
    longitude: 77.2066,
    line: 'yellow',
    subType: 'Yellow Line',
    address: 'Hauz Khas Metro Station Gate No 1, Outer Ring Road, Hauz Khas, New Delhi',
    // Other spellings found in older data and screens
    aliases: ['Hauz Khas Metro Station Gate No 1', 'Hauz Khas Metro Station Exit No 1', 'Hauz Khas Metro Station', 'Hauz Khas']
  },
  {
    key: 'PC',
    name: 'Patel Chowk Metro Station',
    displayName: 'Patel Chowk Metro Station - Exit No. 1',
    shortName: 'Patel Chowk',
    pickupLocationId: 'M-Y-016',
    boothCode: 'PATE',
    latitude: 28.622834,
    longitude: 77.214126,
    line: 'yellow',
    subType: 'Yellow Line',
    address: 'Patel Chowk Metro Station Exit No 1, Sansad Marg, New Delhi',
    aliases: ['Patel Chowk Metro Station Exit No 1', 'Patel Chowk Metro Gate No 1', 'Patel Chowk']
  }
];

// "Hauz Khas  Metro-Gate No.1 " -> "hauz khas metro gate no 1"
function normalizeBooth(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const byKey = new Map(PODS.map((pod) => [pod.key, pod]));
const byNormalizedName = new Map();
for (const pod of PODS) {
  for (const name of [pod.name, pod.displayName, ...pod.aliases]) {
    byNormalizedName.set(normalizeBooth(name), pod);
  }
}

function listPods() {
  return PODS.map((pod) => ({ ...pod, aliases: [...pod.aliases] }));
}

// 'HK' / 'hk' -> the pod, anything else -> null
function getPod(key) {
  if (key == null) return null;
  return byKey.get(String(key).trim().toUpperCase()) || null;
}

// The pod a booth name belongs to, or null. Exact names and known spellings first; a name that merely contains
// the locality ("Hauz Khas Metro Gate No 2") still maps to that locality's pod.
function podForBooth(booth) {
  const normalized = normalizeBooth(booth);
  if (!normalized) return null;
  if (byNormalizedName.has(normalized)) return byNormalizedName.get(normalized);
  for (const pod of PODS) {
    if (normalized.includes(normalizeBooth(pod.shortName))) return pod;
  }
  return null;
}

// Every booth spelling stored in the database for a pod (for exact "$in" filters)
function boothNamesOf(pod) {
  if (!pod) return [];
  return [pod.name, ...pod.aliases];
}

// What the apps need to show a pod (no internal fields)
function publicPod(pod) {
  if (!pod) return null;
  return {
    key: pod.key,
    name: pod.name,
    displayName: pod.displayName,
    shortName: pod.shortName,
    id: pod.pickupLocationId,
    boothCode: pod.boothCode,
    latitude: pod.latitude,
    longitude: pod.longitude,
    lat: pod.latitude,
    lng: pod.longitude,
    line: pod.line,
    subType: pod.subType,
    address: pod.address
  };
}

module.exports = { PODS, normalizeBooth, listPods, getPod, podForBooth, boothNamesOf, publicPod };
