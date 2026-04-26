import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { hash } from "bcryptjs";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { newDb } from "pg-mem";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

type DatabaseMode = "postgres" | "memory";

interface CountRow extends QueryResultRow {
  count: string;
}

interface RoleRow extends QueryResultRow {
  id: number;
}

interface UserLookupRow extends QueryResultRow {
  id: number;
}

interface LogMarkerRow extends QueryResultRow {
  id: number;
}

interface PermissionRow extends QueryResultRow {
  id: number;
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool | null = null;
  private mode: DatabaseMode = "memory";

  async onModuleInit() {
    await this.initialize();
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }

  getMode() {
    return this.mode;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = []
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error("Database pool is not initialized.");
    }

    return this.pool.query<T>(text, values);
  }

  private async initialize() {
    if (this.pool) {
      return;
    }

    this.pool = await this.createPool();
    await this.runInitScripts();
    await this.ensureRolePermissionAssignments();
    const defaultAdminUserId = await this.ensureDefaultAdmin();
    await this.backfillLegacyPptProjectsToAdmin(defaultAdminUserId);
  }

  private async createPool() {
    const databaseUrl = process.env.DATABASE_URL;
    const allowMemoryFallback = (process.env.ALLOW_IN_MEMORY_DB ?? "true") === "true";

    if (databaseUrl) {
      try {
        const pool = new Pool({ connectionString: databaseUrl });
        await pool.query("SELECT 1");
        this.mode = "postgres";
        this.logger.log("Connected to PostgreSQL.");
        return pool;
      } catch (error) {
        if (!allowMemoryFallback) {
          throw error;
        }

        this.logger.warn("PostgreSQL is unavailable. Falling back to pg-mem for local development.");
      }
    }

    const memoryDb = newDb({
      autoCreateForeignKeyIndices: true
    });
    const adapter = memoryDb.adapters.createPg();

    this.mode = "memory";
    this.logger.log("Using pg-mem in-memory PostgreSQL compatibility layer.");
    return new adapter.Pool();
  }

  private async runInitScripts() {
    const initDirectory = resolve(__dirname, "../../../../../infra/database/init");
    const files = readdirSync(initDirectory)
      .filter((file) => file.endsWith(".sql"))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const sql = readFileSync(resolve(initDirectory, file), "utf8");
      await this.query(sql);
    }
  }

  private async ensureDefaultAdmin() {
    const username = process.env.DEFAULT_ADMIN_USERNAME ?? "admin";
    const email = process.env.DEFAULT_ADMIN_EMAIL ?? "admin@example.com";
    const password = process.env.DEFAULT_ADMIN_PASSWORD ?? "Admin@123456";
    const displayName = process.env.DEFAULT_ADMIN_DISPLAY_NAME ?? "Site Admin";
    const isDefaultPassword = password === "Admin@123456";

    if (isDefaultPassword) {
      const warning =
        "DEFAULT_ADMIN_PASSWORD is still using the built-in default. Change it before exposing this environment.";
      if (process.env.NODE_ENV === "production") {
        this.logger.error(warning);
      } else {
        this.logger.warn(warning);
      }
    }

    const roleResult = await this.query<RoleRow>("SELECT id FROM roles WHERE code = $1 LIMIT 1", ["ADMIN"]);
    const role = roleResult.rows[0];

    if (!role) {
      throw new Error("ADMIN role was not initialized.");
    }

    const existingResult = await this.query<UserLookupRow>(
      "SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2) LIMIT 1",
      [username, email]
    );
    const existingUser = existingResult.rows[0];

    let userId = existingUser?.id;

    if (!userId) {
      const passwordHash = await hash(password, 12);
      const insertResult = await this.query<UserLookupRow>(
        `
          INSERT INTO users (
            username,
            email,
            display_name,
            password_hash,
            status,
            must_change_password
          )
          VALUES ($1, $2, $3, $4, 'active', true)
          RETURNING id
        `,
        [username, email, displayName, passwordHash]
      );

      userId = insertResult.rows[0]?.id;
      this.logger.log(`Default admin initialized: ${username}`);
    }

    if (!userId) {
      throw new Error("Failed to initialize default admin user.");
    }

    await this.query(
      "INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, role.id]
    );

    const articleCount = await this.query<CountRow>("SELECT COUNT(*)::text AS count FROM news_articles");
    const count = Number(articleCount.rows[0]?.count ?? "0");

    if (count === 0) {
      this.logger.warn("No news seed data was found after initialization.");
    }

    return userId;
  }

  private async ensureRolePermissionAssignments() {
    const mapping: Record<string, string[]> = {
      ADMIN: ["admin.access", "news.read", "news.write", "user.manage", "role.manage", "llm.manage"],
      USER: ["news.read"],
      EDITOR: ["admin.access", "news.read", "news.write"]
    };

    for (const [roleCode, permissions] of Object.entries(mapping)) {
      const roleResult = await this.query<RoleRow>("SELECT id FROM roles WHERE code = $1 LIMIT 1", [roleCode]);
      const roleId = roleResult.rows[0]?.id;

      if (!roleId) {
        continue;
      }

      for (const permissionCode of permissions) {
        const permissionResult = await this.query<PermissionRow>(
          "SELECT id FROM permissions WHERE code = $1 LIMIT 1",
          [permissionCode]
        );
        const permissionId = permissionResult.rows[0]?.id;

        if (!permissionId) {
          continue;
        }

        await this.query(
          "INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [roleId, permissionId]
        );
      }
    }
  }

  private async backfillLegacyPptProjectsToAdmin(adminUserId: number) {
    const markerAction = "migration.ppt_projects.assign_admin_owner";
    const markerResult = await this.query<LogMarkerRow>(
      `
        SELECT id
        FROM operation_logs
        WHERE action = $1
        LIMIT 1
      `,
      [markerAction]
    );

    if (markerResult.rows[0]) {
      return;
    }

    const updateResult = await this.query<CountRow>(
      `
        WITH moved AS (
          UPDATE ppt_projects
          SET user_id = $1,
              updated_at = NOW()
          RETURNING id
        )
        SELECT COUNT(*)::text AS count
        FROM moved
      `,
      [adminUserId]
    );
    const movedCount = Number(updateResult.rows[0]?.count ?? "0");

    await this.query(
      `
        INSERT INTO operation_logs (user_id, action, target_type, target_id, detail)
        VALUES ($1, $2, 'system', 'ppt-project-ownership', $3::jsonb)
      `,
      [
        adminUserId,
        markerAction,
        JSON.stringify({
          assignedToUserId: adminUserId,
          movedCount
        })
      ]
    );

    this.logger.log(`HTML-PPT project ownership backfill completed. Assigned ${movedCount} project(s) to admin.`);
  }
}
