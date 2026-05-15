// File: backend/services/geocodingService.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// Cache for geocoding results to avoid hitting the API too often
const geocodeCache = new Map();

// Geocode a single address
async function geocodeAddress(address) {
  if (!address || address.trim() === '') {
    return null;
  }

  // Check cache first
  const cacheKey = address.toLowerCase().trim();
  if (geocodeCache.has(cacheKey)) {
    console.log(`Geocoding cache hit for: ${cacheKey}`);
    return geocodeCache.get(cacheKey);
  }

  const photonUrl = process.env.PHOTON_URL || 'http://photon:2322';

  try {
    console.log(`Geocoding address: ${address}`);
    const url = `${photonUrl}/api?q=${encodeURIComponent(address)}&limit=1&lang=en`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`Photon geocoding error: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = await response.json();

    if (data.features && data.features.length > 0) {
      const [lon, lat] = data.features[0].geometry.coordinates; // GeoJSON: [lon, lat]
      const result = { lat, lng: lon };

      console.log(`Geocoded successfully: ${address} -> ${lat}, ${lon}`);
      geocodeCache.set(cacheKey, result);
      return result;
    }

    console.log(`No results found for address: ${address}`);
    return null;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Geocoding timeout for:', address);
    } else {
      console.error('Geocoding error:', error.message);
    }
    return null;
  }
}

// Batch geocode multiple locations with rate limiting
async function batchGeocode(locations, delay = 1500) { // Increased delay to be safer
  const results = [];
  
  for (const location of locations) {
    const addressParts = [
      location.address,
      location.city,
      location.state,
      location.country
    ].filter(Boolean).join(', ');
    
    if (!addressParts.trim()) {
      results.push(location);
      continue;
    }
    
    const cacheKey = addressParts.toLowerCase().trim();
    const wasCached = geocodeCache.has(cacheKey);
    const coords = await geocodeAddress(addressParts);

    results.push({
      ...location,
      latitude: coords?.lat || location.latitude,
      longitude: coords?.lng || location.longitude
    });

    // Rate limiting — only wait if we actually hit the API (not served from cache)
    if (!wasCached) {
      console.log(`Waiting ${delay}ms before next geocoding request...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return results;
}

module.exports = {
  geocodeAddress,
  batchGeocode
};