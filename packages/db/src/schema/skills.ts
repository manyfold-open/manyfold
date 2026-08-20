import { sql } from 'drizzle-orm'
import {
    boolean,
    check,
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex
} from 'drizzle-orm/pg-core'
import { users } from './users'
import { agentRuntimes } from './agentRuntimes'
import { agents } from './agents'
import { catalogCategories } from './catalogCategories'
import { librarySkills } from './librarySkills'

export const skills = pgTable(
    'skills',
    {
        id: text('id').primaryKey(),
        name: text('name').notNull(),
        description: text('description'),
        repoOwner: text('repo_owner').notNull(),
        repoName: text('repo_name').notNull(),
        repoBranch: text('repo_branch').notNull(),
        sourcePath: text('source_path').notNull(),
        latestRevision: text('latest_revision'),
        readmeUrl: text('readme_url'),
        categoryId: text('category_id').references(
            () => catalogCategories.id,
            { onDelete: 'set null' }
        ),
        tags: jsonb('tags')
            .$type<string[]>()
            .notNull()
            .default(sql`'[]'::jsonb`),
        featured: boolean('featured').notNull().default(false),
        hidden: boolean('hidden').notNull().default(false),
        // Set when a discovery scan no longer finds this skill in its repo
        // (removed/moved upstream). Null = present. Non-null rows are filtered
        // out of the user-facing catalog so stale ghosts don't linger with a
        // dead sourcePath; a later scan that finds the skill again clears it.
        missingSince: timestamp('missing_since', { withTimezone: true }),
        // Records the last successful discovery scan that touched this row,
        // regardless of whether content changed. Drives the 6h scan TTL.
        // Decoupled from updatedAt so a no-change scan still refreshes the
        // TTL without misleading the user-facing "Updated" timestamp.
        scannedAt: timestamp('scanned_at', { withTimezone: true }).defaultNow(),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        repoPathUnique: uniqueIndex('skills_repo_path_unique').on(
            table.repoOwner,
            table.repoName,
            table.repoBranch,
            table.sourcePath
        )
    })
)

export const userSkills = pgTable(
    'user_skills',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        skillId: text('skill_id').references(() => skills.id, {
            onDelete: 'cascade'
        }),
        librarySkillId: text('library_skill_id').references(
            () => librarySkills.id,
            { onDelete: 'cascade' }
        ),
        runtimeId: text('runtime_id').references(() => agentRuntimes.id, {
            onDelete: 'cascade'
        }),
        agentId: text('agent_id').references(() => agents.id, {
            onDelete: 'cascade'
        }),
        framework: text('framework', {
            enum: ['claude-code', 'codex', 'gemini-cli', 'hermes']
        }).notNull(),
        enabled: boolean('enabled').notNull().default(true),
        installDir: text('install_dir').notNull(),
        installedRevision: text('installed_revision'),
        installedVersion: text('installed_version'),
        materializeStatus: text('materialize_status', {
            enum: ['installing', 'installed', 'failed']
        })
            .notNull()
            .default('installing'),
        materializeError: text('materialize_error'),
        materializedAt: timestamp('materialized_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        lookupIdx: index('user_skills_lookup_idx').on(
            table.userId,
            table.agentId,
            table.enabled
        ),
        runtimeLookupIdx: index('user_skills_runtime_lookup_idx').on(
            table.userId,
            table.runtimeId,
            table.enabled
        ),
        userSkillUnique: uniqueIndex('user_skills_user_skill_unique').on(
            table.userId,
            table.agentId,
            table.skillId
        ),
        userLibrarySkillUnique: uniqueIndex(
            'user_skills_user_library_skill_unique'
        ).on(table.userId, table.agentId, table.librarySkillId),
        userInstallDirUnique: uniqueIndex(
            'user_skills_user_install_dir_unique'
        ).on(table.userId, table.agentId, table.installDir),
        sourceXor: check(
            'user_skills_source_xor',
            sql`(skill_id IS NULL) <> (library_skill_id IS NULL)`
        )
    })
)

export const skillRepos = pgTable(
    'skill_repos',
    {
        id: text('id').primaryKey(),
        userId: text('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        owner: text('owner').notNull(),
        name: text('name').notNull(),
        branch: text('branch').notNull().default('main'),
        enabled: boolean('enabled').notNull().default(true),
        createdAt: timestamp('created_at', { withTimezone: true })
            .notNull()
            .defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true })
            .notNull()
            .defaultNow()
    },
    (table) => ({
        userIdx: index('skill_repos_user_idx').on(table.userId),
        userRepoUnique: uniqueIndex('skill_repos_user_repo_unique').on(
            table.userId,
            table.owner,
            table.name
        )
    })
)

export type SkillRow = typeof skills.$inferSelect
export type NewSkillRow = typeof skills.$inferInsert
export type UserSkillRow = typeof userSkills.$inferSelect
export type NewUserSkillRow = typeof userSkills.$inferInsert
export type SkillRepoRow = typeof skillRepos.$inferSelect
export type NewSkillRepoRow = typeof skillRepos.$inferInsert
