import { IUser, UserCreateInput } from './types';
import { UserService } from './user-service';
import { formatDate, validateEmail } from './utils';

export { generateId, formatDate } from './utils';

const userService = new UserService();

export async function initializeApi(): Promise<void> {
  await userService.initialize();
}

export async function shutdownApi(): Promise<void> {
  await userService.shutdown();
}

export function handleCreateUser(input: UserCreateInput): IUser {
  return userService.createUser(input);
}

export function handleGetUser(id: string): IUser | undefined {
  return userService.getUser(id);
}

export function handleListUsers(): IUser[] {
  return userService.listUsers();
}

export function handleDeleteUser(id: string): boolean {
  return userService.deleteUser(id);
}

export function validateUserInput(input: UserCreateInput): string[] {
  const errors: string[] = [];
  
  if (!input.name || input.name.trim().length === 0) {
    errors.push('Name is required');
  }
  
  if (!input.email || !validateEmail(input.email)) {
    errors.push('Valid email is required');
  }
  
  return errors;
}

export function formatUserResponse(user: IUser): object {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: formatDate(user.createdAt),
  };
}
