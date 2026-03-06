export function generateId(): string {
  return Math.random().toString(36).substring(2, 15);
}

export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function createTimestamp(): Date {
  return new Date();
}

export function sanitizeInput(input: string): string {
  return input.trim().toLowerCase();
}

export function logMessage(prefix: string, message: string): void {
  const timestamp = formatDate(createTimestamp());
  console.log(`[${timestamp}] ${prefix}: ${message}`);
}
