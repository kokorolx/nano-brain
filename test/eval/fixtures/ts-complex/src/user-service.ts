import { IUser, IService, UserCreateInput } from './types';
import { BaseService } from './base-service';
import { generateId, validateEmail, createTimestamp, sanitizeInput } from './utils';

export class UserService extends BaseService implements IService {
  private users: Map<string, IUser> = new Map();

  constructor() {
    super('UserService');
  }

  public async initialize(): Promise<void> {
    this.log('Initializing user service...');
    await this.doInitialize();
    this.status = 'running';
    this.log('User service initialized');
  }

  public async shutdown(): Promise<void> {
    this.log('Shutting down user service...');
    await this.doShutdown();
    this.status = 'stopped';
  }

  protected async doInitialize(): Promise<void> {
    this.users.clear();
  }

  protected async doShutdown(): Promise<void> {
    this.users.clear();
  }

  public createUser(input: UserCreateInput): IUser {
    const sanitizedEmail = sanitizeInput(input.email);
    if (!validateEmail(sanitizedEmail)) {
      const error = new Error('Invalid email format');
      this.handleError(error);
      throw error;
    }

    const user: IUser = {
      id: generateId(),
      email: sanitizedEmail,
      name: input.name,
      createdAt: createTimestamp(),
    };

    this.users.set(user.id, user);
    this.log(`Created user: ${user.id}`);
    return user;
  }

  public getUser(id: string): IUser | undefined {
    return this.users.get(id);
  }

  public listUsers(): IUser[] {
    return Array.from(this.users.values());
  }

  public deleteUser(id: string): boolean {
    const deleted = this.users.delete(id);
    if (deleted) {
      this.log(`Deleted user: ${id}`);
    }
    return deleted;
  }
}
