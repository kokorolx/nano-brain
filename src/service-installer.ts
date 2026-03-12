import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export type Platform = 'macos' | 'linux' | 'unsupported';

export function detectPlatform(): Platform {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') return 'linux';
  return 'unsupported';
}

export interface ServiceConfig {
  port: number;
  nodePath: string;
  cliPath: string;
  homeDir: string;
  logsDir: string;
}

export function getDefaultServiceConfig(): ServiceConfig {
  const homeDir = os.homedir();
  const logsDir = path.join(homeDir, '.nano-brain', 'logs');
  
  // Resolve a stable npx path — avoid ephemeral npx cache paths
  let npxPath: string;
  try {
    npxPath = execSync('which npx', { encoding: 'utf-8' }).trim();
  } catch {
    npxPath = path.join(path.dirname(process.execPath), 'npx');
  }
  
  return {
    port: 3100,
    nodePath: npxPath,
    cliPath: 'nano-brain',  // npx will resolve this to the latest installed version
    homeDir,
    logsDir,
  };
}

export function generateLaunchdPlist(config: ServiceConfig): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nano-brain.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${config.nodePath}</string>
    <string>${config.cliPath}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${config.port}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${config.logsDir}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${config.logsDir}/server.err</string>
  <key>WorkingDirectory</key>
  <string>${config.homeDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:${path.dirname(config.nodePath)}</string>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
</dict>
</plist>
`;
}

export function generateSystemdService(config: ServiceConfig): string {
  return `[Unit]
Description=nano-brain MCP server
After=network.target

[Service]
Type=simple
ExecStart=${config.nodePath} ${config.cliPath} serve --port ${config.port}
Restart=always
RestartSec=2
StartLimitBurst=5
StartLimitIntervalSec=600
WorkingDirectory=${config.homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${path.dirname(config.nodePath)}
StandardOutput=append:${config.logsDir}/server.log
StandardError=append:${config.logsDir}/server.err

[Install]
WantedBy=default.target
`;
}

export function getLaunchdPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.nano-brain.server.plist');
}

export function getSystemdServicePath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', 'nano-brain.service');
}

export interface InstallResult {
  success: boolean;
  path: string;
  message: string;
}

export function installService(options: { force?: boolean; port?: number } = {}): InstallResult {
  const platform = detectPlatform();
  
  if (platform === 'unsupported') {
    return {
      success: false,
      path: '',
      message: `Unsupported platform: ${process.platform}. Only macOS and Linux are supported.`,
    };
  }
  
  const config = getDefaultServiceConfig();
  if (options.port) {
    config.port = options.port;
  }
  
  fs.mkdirSync(config.logsDir, { recursive: true });
  
  if (platform === 'macos') {
    const plistPath = getLaunchdPlistPath();
    
    if (fs.existsSync(plistPath) && !options.force) {
      return {
        success: false,
        path: plistPath,
        message: `Service already installed at ${plistPath}. Use --force to overwrite.`,
      };
    }
    
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    const plistContent = generateLaunchdPlist(config);
    fs.writeFileSync(plistPath, plistContent);
    
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootstrap gui/${uid} "${plistPath}"`, { stdio: 'pipe' });
    } catch {
      try {
        execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
      } catch {}
    }
    
    return {
      success: true,
      path: plistPath,
      message: `Service installed at ${plistPath}`,
    };
  }
  
  const servicePath = getSystemdServicePath();
  
  if (fs.existsSync(servicePath) && !options.force) {
    return {
      success: false,
      path: servicePath,
      message: `Service already installed at ${servicePath}. Use --force to overwrite.`,
    };
  }
  
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  const serviceContent = generateSystemdService(config);
  fs.writeFileSync(servicePath, serviceContent);
  
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync('systemctl --user enable nano-brain', { stdio: 'pipe' });
    execSync('systemctl --user start nano-brain', { stdio: 'pipe' });
  } catch {
  }
  
  return {
    success: true,
    path: servicePath,
    message: `Service installed at ${servicePath}`,
  };
}

export function uninstallService(): InstallResult {
  const platform = detectPlatform();
  
  if (platform === 'unsupported') {
    return {
      success: false,
      path: '',
      message: `Unsupported platform: ${process.platform}. Only macOS and Linux are supported.`,
    };
  }
  
  if (platform === 'macos') {
    const plistPath = getLaunchdPlistPath();
    
    if (!fs.existsSync(plistPath)) {
      return {
        success: false,
        path: plistPath,
        message: `Service not installed at ${plistPath}`,
      };
    }
    
    try {
      const uid = execSync('id -u', { encoding: 'utf-8' }).trim();
      execSync(`launchctl bootout gui/${uid}/com.nano-brain.server`, { stdio: 'pipe' });
    } catch {
      try {
        execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
      } catch {}
    }
    
    fs.unlinkSync(plistPath);
    
    return {
      success: true,
      path: plistPath,
      message: `Service uninstalled from ${plistPath}`,
    };
  }
  
  const servicePath = getSystemdServicePath();
  
  if (!fs.existsSync(servicePath)) {
    return {
      success: false,
      path: servicePath,
      message: `Service not installed at ${servicePath}`,
    };
  }
  
  try {
    execSync('systemctl --user disable --now nano-brain', { stdio: 'pipe' });
  } catch {
  }
  
  fs.unlinkSync(servicePath);
  
  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  } catch {
  }
  
  return {
    success: true,
    path: servicePath,
    message: `Service uninstalled from ${servicePath}`,
  };
}
