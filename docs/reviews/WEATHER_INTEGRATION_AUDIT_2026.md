# Audit Report: Weather & ROI Correlation Subsystem
**Date:** 2026-04-08
**Status:** High Accuracy / Cost-Optimized
**Auditor:** Anti-gravity

## 1. Executive Summary
The Weather Integration is a strategic ROI tool that correlates store performance with environmental conditions. By integrating the Visual Crossing Timeline API, Riverside OS provides store owners with data-driven insights into how rain, snow, and temperature impact foot traffic and sales velocity.

## 2. Technical Implementation

### 2.1 API Integration & Quota Management
- **Vendor**: Visual Crossing (Timeline API).
- **Quota Guard**: The system implements an outbound request cap (default **850 pulls/day**) tracked in the `weather_vc_daily_usage` table. This prevents unexpected API overages and allows the store to operate within the "Free/Pro" tiers reliably.
- **Cache Layer**: A 15-minute in-memory cache (`vc_cache_map`) dedupes identical requests across staff terminals, further protecting the API quota.

### 2.2 Intelligent Fallback
- **Mock Fallback**: If the API key is missing, the quota is reached, or the upstream service is down, the system shifts to **"Buffalo-style" deterministic mock data**.
- **User Experience**: This ensures that dashboards (like the "Action Board") always show data, preventing UI breaks during connectivity issues.

## 3. Data Correlation & ROI

### 3.1 Session & Order Snapshots
- **Capture**: Weather data is snapshotted into `register_sessions.weather_snapshot` and `orders.weather_snapshot` during the "Open/Close" and "Book Order" events.
- **BI Integration**: These JSONB snapshots are consumable by Metabase, allowing for advanced queries like: *"Show total revenue on days where precipitation > 0.5 inches."*

### 3.2 Nightly Snapshot Finalization
- **The "Finalizer"**: A nightly job (`maybe_finalize_daily_weather_snapshots`) runs at 3 AM local time.
- **Purpose**: Forecasts can be wrong. The finalizer re-fetches the **actual historical weather** for the previous day and overwrites the initial snapshots on closed sessions. 
- **Integrity**: This transforms the "Forecast" into "Historical Fact," ensuring the Sales Pivot remains an accurate record for year-over-year analysis.

## 4. Maintenance & Configuration
- **Env Overrides**: `RIVERSIDE_VISUAL_CROSSING_ENABLED` allows IT to toggle the integration globally without modifying database settings.
- **Location Aware**: The system uses store-local timezones (`America/New_York`) to ensure the "Finalizer" job runs during the correct low-traffic window.

## 5. Findings & Recommendations
1. **Precision Correlation**: The nightly finalization job is a high-quality feature that separates Riverside OS from generic POS systems.
2. **Quota Handling**: The use of a database table to track API usage is a robust architectural choice for distributed staff terminals.
3. **Observation**: The system defaults to "Buffalo, NY" for mock data. **Recommendation**: Set store-specific mock defaults if the operation expands to warmer climates.

## 6. Conclusion
The Weather Correlation subsystem is **production-ready and operationally mature**. It provides significant business value by translating external environmental factors into actionable internal sales intelligence.
