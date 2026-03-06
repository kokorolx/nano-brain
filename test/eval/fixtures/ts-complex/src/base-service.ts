import { ServiceStatus, ILogger } from './types';
import { logMessage } from './utils';

export abstract class BaseService {
  protected status: ServiceStatus = 'idle';
  protected logger: ILogger | null = null;

  constructor(protected serviceName: string) {}

  protected log(message: string): void {
    if (this.logger) {
      this.logger.log(message);
    } else {
      logMessage(this.serviceName, message);
    }
  }

  protected handleError(error: Error): void {
    this.log(`Error: ${error.message}`);
    if (this.logger) {
      this.logger.error(error.message, error);
    }
  }

  public getStatus(): ServiceStatus {
    return this.status;
  }

  public setLogger(logger: ILogger): void {
    this.logger = logger;
    this.log('Logger attached');
  }

  protected abstract doInitialize(): Promise<void>;
  protected abstract doShutdown(): Promise<void>;
}
