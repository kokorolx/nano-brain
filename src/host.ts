import { accessSync, readFileSync } from 'fs';

let cachedIsInsideContainer: boolean | null = null;

export function isInsideContainer(): boolean {
  if (process.env.NANO_BRAIN_DIRECT === '1') {
    return false;
  }

  if (cachedIsInsideContainer !== null) {
    return cachedIsInsideContainer;
  }

  try {
    accessSync('/.dockerenv');
    cachedIsInsideContainer = true;
    return true;
  } catch {
    try {
      const cgroup = readFileSync('/proc/1/cgroup', 'utf-8');
      cachedIsInsideContainer = cgroup.includes('docker') || cgroup.includes('containerd');
      return cachedIsInsideContainer;
    } catch {
      cachedIsInsideContainer = false;
      return false;
    }
  }
}

export function resolveHostUrl(url: string): string {
  if (!isInsideContainer()) {
    return url;
  }
  return url.replace(/\b(localhost|127\.0\.0\.1)\b/g, 'host.docker.internal');
}
