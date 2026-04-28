import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException
} from "@nestjs/common";
import { compare, hash } from "bcryptjs";
import {
  sign,
  verify,
  type JwtPayload,
  type Secret,
  type SignOptions
} from "jsonwebtoken";
import type { QueryResultRow } from "pg";
import { DatabaseService } from "../database/database.service";
import type { AuthPayload, AuthResponse, AuthenticatedUser } from "./auth.types";

interface UserRow extends QueryResultRow {
  id: number;
  username: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  status: string;
  must_change_password: boolean;
}

interface ProfileRow extends QueryResultRow {
  id: number;
  username: string;
  email: string;
  display_name: string | null;
  status: string;
  must_change_password: boolean;
  roles: string[] | null;
  permissions: string[] | null;
}

interface InsertUserRow extends QueryResultRow {
  id: number;
}

interface UserSummaryRow extends QueryResultRow {
  id: number;
  username: string;
  email: string;
  display_name: string | null;
  status: string;
  must_change_password: boolean;
  roles: string[] | null;
  created_at: Date | string;
  last_login_at: Date | string | null;
}

@Injectable()
export class AuthService {
  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  async register(body: Record<string, unknown>) {
    const username = this.validateUsername(body.username);
    const email = this.validateEmail(body.email);
    const password = this.validatePassword(body.password);
    const displayName = this.normalizeOptionalString(body.displayName);

    const duplicate = await this.databaseService.query<InsertUserRow>(
      `
        SELECT id
        FROM users
        WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)
        LIMIT 1
      `,
      [username, email]
    );

    if (duplicate.rows[0]) {
      throw new BadRequestException("Username or email already exists.");
    }

    const passwordHash = await hash(password, 12);
    const userResult = await this.databaseService.query<InsertUserRow>(
      `
        INSERT INTO users (
          username,
          email,
          display_name,
          password_hash,
          status,
          must_change_password
        )
        VALUES ($1, $2, $3, $4, 'active', false)
        RETURNING id
      `,
      [username, email, displayName, passwordHash]
    );
    const userId = userResult.rows[0]?.id;

    if (!userId) {
      throw new BadRequestException("Failed to create user.");
    }

    await this.assignRole(userId, "USER");
    await this.writeOperationLog(userId, "auth.register", "user", String(userId), {
      username,
      email
    });

    return {
      user: await this.getProfileById(userId)
    };
  }

  async login(body: Record<string, unknown>): Promise<AuthResponse> {
    const identifier = this.validateIdentifier(body.username ?? body.email ?? body.identifier);
    const password = this.validatePassword(body.password);

    const result = await this.databaseService.query<UserRow>(
      `
        SELECT
          id,
          username,
          email,
          display_name,
          password_hash,
          status,
          must_change_password
        FROM users
        WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($1)
        LIMIT 1
      `,
      [identifier]
    );
    const user = result.rows[0];

    if (!user) {
      throw new UnauthorizedException("Invalid credentials.");
    }

    if (user.status !== "active") {
      throw new UnauthorizedException("User account is disabled.");
    }

    const passwordMatches = await compare(password, user.password_hash);

    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid credentials.");
    }

    await this.databaseService.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);
    await this.writeOperationLog(user.id, "auth.login", "user", String(user.id), {
      username: user.username
    });

    const profile = await this.getProfileById(user.id);

    return {
      accessToken: this.signAccessToken(profile),
      expiresIn: String(this.getExpiresIn() ?? "7d"),
      user: profile
    };
  }

  async getProfileById(userId: number): Promise<AuthenticatedUser> {
    const result = await this.databaseService.query<ProfileRow>(
      `
        SELECT
          u.id,
          u.username,
          u.email,
          u.display_name,
          u.status,
          u.must_change_password,
          COALESCE(ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
          COALESCE(ARRAY_AGG(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        LEFT JOIN role_permissions rp ON rp.role_id = r.id
        LEFT JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = $1
        GROUP BY
          u.id,
          u.username,
          u.email,
          u.display_name,
          u.status,
          u.must_change_password
      `,
      [userId]
    );
    const row = result.rows[0];

    if (!row) {
      throw new UnauthorizedException("User profile was not found.");
    }

    if (row.status !== "active") {
      throw new UnauthorizedException("User account is disabled.");
    }

    return {
      id: row.id,
      username: row.username,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      mustChangePassword: row.must_change_password,
      roles: row.roles ?? [],
      permissions: row.permissions ?? []
    };
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser> {
    try {
      const payload = verify(token, this.getJwtSecret()) as JwtPayload | string;

      const subject =
        payload && typeof payload !== "string"
          ? typeof payload.sub === "number"
            ? payload.sub
            : typeof payload.sub === "string" && /^\d+$/.test(payload.sub)
              ? Number(payload.sub)
              : null
          : null;

      if (!subject) {
        throw new UnauthorizedException("Invalid token payload.");
      }

      return this.getProfileById(subject);
    } catch {
      throw new UnauthorizedException("Invalid or expired access token.");
    }
  }

  async listUsers() {
    const result = await this.databaseService.query<UserSummaryRow>(
      `
        SELECT
          u.id,
          u.username,
          u.email,
          u.display_name,
          u.status,
          u.must_change_password,
          u.created_at,
          u.last_login_at,
          COALESCE(ARRAY_AGG(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
        FROM users u
        LEFT JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN roles r ON r.id = ur.role_id
        GROUP BY
          u.id,
          u.username,
          u.email,
          u.display_name,
          u.status,
          u.must_change_password,
          u.created_at,
          u.last_login_at
        ORDER BY u.created_at ASC
      `
    );

    return result.rows.map((row) => ({
      id: row.id,
      username: row.username,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      mustChangePassword: row.must_change_password,
      roles: row.roles ?? [],
      createdAt: new Date(row.created_at).toISOString(),
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null
    }));
  }

  private async assignRole(userId: number, roleCode: string) {
    await this.databaseService.query(
      `
        INSERT INTO user_roles (user_id, role_id)
        SELECT $1, id
        FROM roles
        WHERE code = $2
        ON CONFLICT DO NOTHING
      `,
      [userId, roleCode]
    );
  }

  private signAccessToken(user: AuthenticatedUser) {
    const payload: AuthPayload = {
      sub: user.id,
      username: user.username
    };

    return sign(
      payload,
      this.getJwtSecret(),
      {
        expiresIn: this.getExpiresIn()
      }
    );
  }

  private getJwtSecret(): Secret {
    const secret = process.env.JWT_SECRET?.trim();
    if (secret) {
      return secret;
    }
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET environment variable is required in production. Refusing to start with the development default."
      );
    }
    return "change-this-in-phase-2";
  }

  private getExpiresIn(): SignOptions["expiresIn"] {
    return (process.env.JWT_EXPIRES_IN ?? "7d") as SignOptions["expiresIn"];
  }

  private validateUsername(input: unknown) {
    const value = this.normalizeRequiredString(input, "username");

    if (!/^[a-zA-Z0-9_\-]{3,32}$/.test(value)) {
      throw new BadRequestException(
        "Username must be 3-32 characters and use letters, numbers, underscores, or hyphens."
      );
    }

    return value;
  }

  private validateEmail(input: unknown) {
    const value = this.normalizeRequiredString(input, "email").toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new BadRequestException("Email format is invalid.");
    }

    return value;
  }

  private validateIdentifier(input: unknown) {
    return this.normalizeRequiredString(input, "identifier").toLowerCase();
  }

  private validatePassword(input: unknown) {
    const value = this.normalizeRequiredString(input, "password");

    if (value.length < 8) {
      throw new BadRequestException("Password must be at least 8 characters long.");
    }

    return value;
  }

  private normalizeRequiredString(input: unknown, field: string) {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new BadRequestException(`${field} is required.`);
    }

    return input.trim();
  }

  private normalizeOptionalString(input: unknown) {
    if (typeof input !== "string") {
      return null;
    }

    const value = input.trim();
    return value.length > 0 ? value : null;
  }

  private async writeOperationLog(
    userId: number,
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown>
  ) {
    await this.databaseService.query(
      `
        INSERT INTO operation_logs (user_id, action, target_type, target_id, detail)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `,
      [userId, action, targetType, targetId, JSON.stringify(detail)]
    );
  }
}
