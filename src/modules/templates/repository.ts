/**
 * Repository de Template — espelho local de message_templates Meta.
 */

import { and, asc, eq, sql } from "drizzle-orm";

import { templates, type Template } from "@db/schema/index.js";

import { getDb } from "@/db/client.js";

export interface UpsertTemplateInput {
  wabaConnectionId: string;
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  status: "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED";
  qualityScore: number | null;
  components: unknown[];
}

export async function upsertTemplate(input: UpsertTemplateInput): Promise<Template> {
  const [row] = await getDb()
    .insert(templates)
    .values({
      wabaConnectionId: input.wabaConnectionId,
      name: input.name,
      language: input.language,
      category: input.category,
      metaStatus: input.status,
      metaQualityScore: input.qualityScore,
      componentsJson: input.components,
    })
    .onConflictDoUpdate({
      target: [templates.wabaConnectionId, templates.name, templates.language],
      set: {
        category: sql`excluded.category`,
        metaStatus: sql`excluded.meta_status`,
        metaQualityScore: sql`excluded.meta_quality_score`,
        componentsJson: sql`excluded.components_json`,
        updatedAt: sql`now()`,
        lastSyncedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error("template upsert returned no row");
  return row;
}

export async function listTemplatesByWaba(
  wabaConnectionId: string,
  filter: { status?: string; language?: string } = {},
): Promise<Template[]> {
  const conds = [eq(templates.wabaConnectionId, wabaConnectionId)];
  if (filter.status) {
    conds.push(eq(templates.metaStatus, filter.status as "PENDING"));
  }
  if (filter.language) conds.push(eq(templates.language, filter.language));
  return getDb()
    .select()
    .from(templates)
    .where(and(...conds))
    .orderBy(asc(templates.name));
}

export async function findTemplate(
  wabaConnectionId: string,
  name: string,
  language: string,
): Promise<Template | null> {
  const rows = await getDb()
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.wabaConnectionId, wabaConnectionId),
        eq(templates.name, name),
        eq(templates.language, language),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteTemplate(
  wabaConnectionId: string,
  name: string,
  language: string,
): Promise<boolean> {
  const rows = await getDb()
    .delete(templates)
    .where(
      and(
        eq(templates.wabaConnectionId, wabaConnectionId),
        eq(templates.name, name),
        eq(templates.language, language),
      ),
    )
    .returning({ id: templates.id });
  return rows.length > 0;
}
