import { Injectable } from '@nestjs/common';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogEntry {
  level:     LogLevel;
  service:   string;
  action:    string;
  data?:     Record<string, unknown>;
  timestamp: string;
  traceId?:  string;
}

@Injectable()
export class OpsLoggerService {
  private write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (entry.level === 'error' || entry.level === 'critical') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  log(action: string, service = 'System', data?: Record<string, unknown>): void {
    this.write({ level: 'info', service, action, data, timestamp: new Date().toISOString() });
  }

  debug(action: string, service = 'System', data?: Record<string, unknown>): void {
    this.write({ level: 'debug', service, action, data, timestamp: new Date().toISOString() });
  }

  warn(action: string, service = 'System', data?: Record<string, unknown>): void {
    this.write({ level: 'warn', service, action, data, timestamp: new Date().toISOString() });
  }

  error(action: string, service = 'System', data?: Record<string, unknown>): void {
    this.write({ level: 'error', service, action, data, timestamp: new Date().toISOString() });
  }

  critical(action: string, service = 'System', data?: Record<string, unknown>): void {
    this.write({ level: 'critical', service, action, data, timestamp: new Date().toISOString() });
  }

  structured(entry: Omit<LogEntry, 'timestamp'>): void {
    this.write({ ...entry, timestamp: new Date().toISOString() });
  }
}
