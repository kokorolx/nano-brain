export interface IUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export interface IService {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ILogger {
  log(message: string): void;
  error(message: string, error?: Error): void;
}

export type UserCreateInput = Omit<IUser, 'id' | 'createdAt'>;

export type ServiceStatus = 'idle' | 'running' | 'stopped';
