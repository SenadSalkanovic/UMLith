export function logInfo(message: string, context?: Record<string, unknown>): void {
  console.log(`[INFO] ${message}`, context ? JSON.stringify(context) : '');
}

export function logWarn(message: string, context?: Record<string, unknown>): void {
  console.warn(`[WARN] ${message}`, context ? JSON.stringify(context) : '');
}

export function logError(message: string, error?: unknown): void {
  console.error(`[ERROR] ${message}`, error);
}
