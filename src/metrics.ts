/**
 * Simple metrics system for nano-brain
 * Tracks operational counters and events
 * 
 * Can be extended to export to Prometheus, datadog, etc.
 */

interface MetricCounter {
  name: string;
  value: number;
  labels?: Record<string, string>;
}

/**
 * In-memory metrics store
 */
const counters = new Map<string, number>();
const events: Array<{ timestamp: string; name: string; details?: any }> = [];

/**
 * Increment a counter
 */
export function incrementCounter(name: string, amount: number = 1): void {
  const current = counters.get(name) || 0;
  counters.set(name, current + amount);
  
  // Also log as event for aggregation
  recordEvent(name);
}

/**
 * Get current counter value
 */
export function getCounter(name: string): number {
  return counters.get(name) || 0;
}

/**
 * Record an event for monitoring
 */
export function recordEvent(name: string, details?: any): void {
  events.push({
    timestamp: new Date().toISOString(),
    name,
    details
  });
  
  // Keep last 1000 events only
  if (events.length > 1000) {
    events.shift();
  }
}

/**
 * Get all metrics as Prometheus text format
 * Can be exposed on /metrics endpoint
 */
export function getMetricsAsPrometheus(): string {
  const lines: string[] = [];
  
  // HELP section
  lines.push('# HELP database_corruption_detected Total database corruptions detected and recovered');
  lines.push('# TYPE database_corruption_detected counter');
  
  const corruptionCount = counters.get('database_corruption_detected') || 0;
  lines.push(`database_corruption_detected{service="nano-brain"} ${corruptionCount}`);
  
  // Add any other metrics here
  lines.push('');
  
  return lines.join('\n');
}

/**
 * Get recent events for debugging
 */
export function getRecentEvents(limit: number = 100): typeof events {
  return events.slice(-limit);
}

/**
 * Reset all metrics (useful for testing)
 */
export function resetMetrics(): void {
  counters.clear();
  events.length = 0;
}

/**
 * Export metrics data
 */
export function exportMetrics() {
  return {
    counters: Object.fromEntries(counters),
    events: events.slice(-100),
    timestamp: new Date().toISOString()
  };
}
