// File: backend/services/improvedGeocodingService.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

class ImprovedGeocodingService {
  constructor(pool) {
    this.pool = pool;
    this.initializeDatabase();
  }

  async initializeDatabase() {
    try {
      // Create geocoding cache table
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS geocoding_cache (
          id SERIAL PRIMARY KEY,
          address_hash VARCHAR(64) UNIQUE NOT NULL,
          original_address TEXT NOT NULL,
          normalized_address TEXT NOT NULL,
          latitude DECIMAL(10, 8),
          longitude DECIMAL(11, 8),
          confidence_score INTEGER DEFAULT 0,
          provider VARCHAR(50) DEFAULT 'nominatim',
          country_code VARCHAR(2),
          city VARCHAR(100),
          state VARCHAR(100),
          postal_code VARCHAR(20),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Create index for faster lookups
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_geocoding_cache_hash ON geocoding_cache(address_hash);
        CREATE INDEX IF NOT EXISTS idx_geocoding_cache_address ON geocoding_cache(normalized_address);
      `);

      console.log('Geocoding cache database initialized');
    } catch (error) {
      console.error('Error initializing geocoding cache:', error);
    }
  }

  // Create a hash for address caching
  createAddressHash(address) {
    const crypto = require('crypto');
    const normalized = this.normalizeAddress(address);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  // Normalize address for better matching
  normalizeAddress(address) {
    if (!address) return '';
    return address.toLowerCase()
      .replace(/[^\w\s,.-]/g, '') // Remove special chars except common ones
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/\b(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|place|pl)\b/g, '$1') // Normalize street types
      .trim();
  }

  // Check database cache first
  async getCachedCoordinates(address) {
    const hash = this.createAddressHash(address);
    try {
      const result = await this.pool.query(
        'SELECT latitude, longitude, confidence_score, city, state, country_code FROM geocoding_cache WHERE address_hash = $1',
        [hash]
      );
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        return {
          lat: parseFloat(row.latitude),
          lng: parseFloat(row.longitude),
          confidence: row.confidence_score,
          city: row.city,
          state: row.state,
          country: row.country_code,
          cached: true
        };
      }
    } catch (error) {
      console.error('Error checking cache:', error);
    }
    return null;
  }

  // Cache coordinates in database
  async cacheCoordinates(address, result) {
    const hash = this.createAddressHash(address);
    const normalized = this.normalizeAddress(address);
    
    try {
      await this.pool.query(`
        INSERT INTO geocoding_cache 
        (address_hash, original_address, normalized_address, latitude, longitude, confidence_score, city, state, country_code, provider)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (address_hash) 
        DO UPDATE SET 
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          confidence_score = EXCLUDED.confidence_score,
          updated_at = CURRENT_TIMESTAMP
      `, [
        hash, address, normalized, result.lat, result.lng, 
        result.confidence || 50, result.city || null, result.state || null,
        result.country || null, result.provider || 'photon'
      ]);
    } catch (error) {
      console.error('Error caching coordinates:', error);
    }
  }

  // Geocode using self-hosted Photon (OSM-backed, no API key required)
  async geocodeWithPhoton(address) {
    const photonUrl = process.env.PHOTON_URL || 'http://photon:2322';
    try {
      const url = `${photonUrl}/api?q=${encodeURIComponent(address)}&limit=5&lang=en`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) return null;
      const data = await response.json();

      if (data.features && data.features.length > 0) {
        const best = data.features[0];
        const [lon, lat] = best.geometry.coordinates; // GeoJSON is [lon, lat]
        const props = best.properties;

        return {
          lat,
          lng: lon,
          confidence: this.calculatePhotonConfidence(best, address),
          city: props.city || props.district,
          state: props.state || props.county,
          country: props.countrycode,
          displayName: this.buildDisplayName(props),
          provider: 'photon',
          alternatives: data.features.slice(1, 3).map(f => ({
            lat: f.geometry.coordinates[1],
            lng: f.geometry.coordinates[0],
            display_name: this.buildDisplayName(f.properties)
          }))
        };
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('Photon geocoding timeout for:', address);
      } else {
        console.error('Photon geocoding error:', error.message);
      }
    }
    return null;
  }

  // Build a human-readable display name from Photon properties
  buildDisplayName(props) {
    const parts = [
      props.housenumber && props.street ? `${props.housenumber} ${props.street}` : props.street,
      props.district,
      props.city,
      props.state,
      props.country
    ].filter(Boolean);
    return parts.join(', ');
  }

  // Confidence based on Photon result type
  calculatePhotonConfidence(feature, originalAddress) {
    const props = feature.properties;
    const typeScores = {
      house: 95, street: 75, district: 60, city: 55,
      county: 45, state: 35, country: 25
    };
    let score = typeScores[props.type] || 50;

    const original = originalAddress.toLowerCase();
    if (props.city && original.includes(props.city.toLowerCase())) score += 5;
    if (props.street && original.includes(props.street.toLowerCase())) score += 5;
    if (props.postcode && original.includes(props.postcode)) score += 5;

    return Math.min(100, Math.max(0, score));
  }

  // Smart geocoding with fallbacks and validation
  async geocodeAddress(address, options = {}) {
    if (!address || address.trim() === '') return null;

    const normalizedAddress = address.trim();
    
    // Check cache first
    let cached = await this.getCachedCoordinates(normalizedAddress);
    if (cached && cached.confidence > (options.minConfidence || 30)) {
      return cached;
    }

    let result = await this.geocodeWithPhoton(normalizedAddress);

    if (!result) {
      // Try with simplified address if no results
      const simplified = this.simplifyAddress(normalizedAddress);
      if (simplified !== normalizedAddress) {
        result = await this.geocodeWithPhoton(simplified);
      }
    }

    if (result && result.confidence > (options.minConfidence || 30)) {
      // Cache the result
      await this.cacheCoordinates(normalizedAddress, result);
      return result;
    }

    return null;
  }

  // Simplify address for better matching
  simplifyAddress(address) {
    return address
      .replace(/\b(apt|apartment|unit|ste|suite|#)\s*\d+.*$/i, '') // Remove apartment numbers
      .replace(/\b\d+[a-z]?\s+(st|nd|rd|th)\s+/i, '') // Remove ordinal street numbers
      .replace(/\s+floor\s*\d+.*$/i, '') // Remove floor numbers
      .trim();
  }

  // Batch geocode with smart processing
  async batchGeocode(locations, options = {}) {
    const results = [];
    const maxConcurrent = options.maxConcurrent || 3;
    const chunks = this.chunkArray(locations, maxConcurrent);
    
    for (const chunk of chunks) {
      const promises = chunk.map(async (location) => {
        const addressParts = [
          location.address,
          location.city,
          location.state,
          location.country
        ].filter(Boolean);
        
        if (addressParts.length === 0) return location;
        
        // Try full address first
        const fullAddress = addressParts.join(', ');
        let coords = await this.geocodeAddress(fullAddress, options);
        
        // If full address fails and we have city+country, try that as fallback
        if (!coords && location.city && location.country) {
          const cityCountry = [location.city, location.country].join(', ');
          coords = await this.geocodeAddress(cityCountry, { ...options, minConfidence: 25 });
          if (coords) {
            coords.confidence = Math.max(25, coords.confidence - 15); // Lower confidence for city-level
          }
        }
        
        // If still no results and we have just country, try country-level
        if (!coords && location.country && !location.city) {
          coords = await this.geocodeAddress(location.country, { ...options, minConfidence: 20 });
          if (coords) {
            coords.confidence = Math.max(20, coords.confidence - 25); // Even lower confidence for country-level
          }
        }
        
        return {
          ...location,
          latitude: coords?.lat || location.latitude,
          longitude: coords?.lng || location.longitude,
          geocode_confidence: coords?.confidence || 0,
          geocode_provider: coords?.provider || null,
          geocoded_at: coords ? new Date().toISOString() : null
        };
      });
      
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);
      
      // Delay between chunks
      if (chunks.indexOf(chunk) < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    return results;
  }

  // Utility to chunk array
  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  // Address suggestions for autocomplete
  async getSuggestions(query, limit = 5) {
    if (!query || query.length < 3) return [];
    const photonUrl = process.env.PHOTON_URL || 'http://photon:2322';

    try {
      const url = `${photonUrl}/api?q=${encodeURIComponent(query)}&limit=${limit}&lang=en`;
      const response = await fetch(url);
      if (!response.ok) return [];
      const data = await response.json();

      return (data.features || []).map(feature => {
        const [lon, lat] = feature.geometry.coordinates;
        const props = feature.properties;
        return {
          display_name: this.buildDisplayName(props),
          address: {
            street: props.housenumber && props.street
              ? `${props.housenumber} ${props.street}`
              : props.street,
            city: props.city || props.district,
            state: props.state,
            country: props.country,
            postal_code: props.postcode
          },
          lat,
          lng: lon,
          confidence: this.calculatePhotonConfidence(feature, query)
        };
      }).sort((a, b) => b.confidence - a.confidence);
    } catch (error) {
      console.error('Error getting address suggestions from Photon:', error.message);
      return [];
    }
  }

  // Get cache statistics
  async getCacheStats() {
    try {
      const stats = await this.pool.query(`
        SELECT 
          COUNT(*) as total_cached,
          COUNT(CASE WHEN latitude IS NOT NULL THEN 1 END) as successful_geocodes,
          AVG(confidence_score) as avg_confidence,
          COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as cached_today
        FROM geocoding_cache
      `);
      
      return stats.rows[0];
    } catch (error) {
      console.error('Error getting cache stats:', error);
      return null;
    }
  }
}

module.exports = ImprovedGeocodingService;