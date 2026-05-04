import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log, cliOutput, cliError } from '../../logger.js';

function printLastLines(filePath: string, n: number): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const allLines = content.split('\n').filter(l => l.length > 0);
  const start = Math.max(0, allLines.length - n);
  const selected = allLines.slice(start);
  if (start > 0) {
    cliOutput('... (' + start + ' earlier lines omitted, use -n to show more)');
  }
  for (const line of selected) {
    cliOutput(line);
  }
}

export async function handleLogs(commandArgs: string[]): Promise<void> {
  const logsDir = path.join(os.homedir(), '.nano-brain', 'logs');

  if (commandArgs[0] === 'path') {
    cliOutput(logsDir);
    return;
  }

  let follow = false;
  let lines = 50;
  let date = new Date().toISOString().split('T')[0];
  let clear = false;
  let logFile: string | null = null;

  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (arg === '-n' && i + 1 < commandArgs.length) {
      lines = parseInt(commandArgs[++i], 10);
    } else if (arg.startsWith('--date=')) {
      date = arg.substring(7);
    } else if (arg === '--clear') {
      clear = true;
    } else if (!arg.startsWith('-')) {
      logFile = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
    }
  }

  log('cli', 'logs follow=' + follow + ' lines=' + lines + ' date=' + date + ' clear=' + clear);

  if (clear) {
    if (!fs.existsSync(logsDir)) {
      cliOutput('No logs directory');
      return;
    }
    const files = fs.readdirSync(logsDir).filter(f => f.startsWith('nano-brain-') && f.endsWith('.log'));
    for (const file of files) {
      fs.unlinkSync(path.join(logsDir, file));
    }
    cliOutput('Cleared ' + files.length + ' log file(s)');
    return;
  }

  if (!logFile) {
    logFile = path.join(logsDir, 'nano-brain-' + date + '.log');
  }

  if (!fs.existsSync(logFile)) {
    cliOutput('No log file: ' + logFile);
    cliOutput('Enable logging: set logging.enabled: true in ~/.nano-brain/config.yml');
    return;
  }

  if (follow) {
    const { spawn } = await import('child_process');
    const tail = spawn('tail', ['-f', '-n', String(lines), logFile], { stdio: 'inherit' });
    tail.on('error', () => {
      cliError('tail command not available, showing last ' + lines + ' lines instead');
      printLastLines(logFile!, lines);
    });
    await new Promise<void>((resolve) => {
      tail.on('close', () => resolve());
      process.on('SIGINT', () => { tail.kill(); resolve(); });
    });
  } else {
    printLastLines(logFile, lines);
  }
}
