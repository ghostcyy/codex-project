export interface AuthenticatedUser {
  id: number;
  username: string;
  email: string;
  displayName: string | null;
  status: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
}

export interface AuthPayload {
  sub: number;
  username: string;
}

export interface AuthResponse {
  accessToken: string;
  expiresIn: string;
  user: AuthenticatedUser;
}

