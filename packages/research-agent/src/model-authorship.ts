import type { DatabaseSync } from "node:sqlite";

export const MODEL_AUTHORED_RESOURCE_KINDS = ["memory", "runbook", "report"] as const;
export type ModelAuthoredResourceKind = (typeof MODEL_AUTHORED_RESOURCE_KINDS)[number];

export interface ModelAuthor {
  provider: string;
  model: string;
}

export function recordModelAuthorship(
  database: DatabaseSync,
  resourceKind: ModelAuthoredResourceKind,
  resourceId: string,
  revision: number,
  author: ModelAuthor | undefined,
  createdAt: string,
): void {
  if (!author) return;
  const provider = author.provider.trim();
  const model = author.model.trim();
  if (!provider || !model) return;
  database.prepare(`
    INSERT OR IGNORE INTO honeycrisp_model_authorship (
      resource_kind, resource_id, revision, provider, model, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(resourceKind, resourceId, revision, provider, model, createdAt);
}

export function moveModelAuthorship(
  database: DatabaseSync,
  resourceKind: ModelAuthoredResourceKind,
  previousId: string,
  nextId: string,
): void {
  if (previousId === nextId || !modelAuthorshipTableExists(database)) return;
  database.prepare(`
    UPDATE honeycrisp_model_authorship
    SET resource_id = ?
    WHERE resource_kind = ? AND resource_id = ?
  `).run(nextId, resourceKind, previousId);
}

export function modelAuthorsForResource(
  database: DatabaseSync,
  resourceKind: ModelAuthoredResourceKind,
  resourceId: string,
): ModelAuthor[] {
  return modelAuthorsByResource(database, resourceKind, [resourceId]).get(resourceId) ?? [];
}

export function modelAuthorsByResource(
  database: DatabaseSync,
  resourceKind: ModelAuthoredResourceKind,
  resourceIds: readonly string[],
): Map<string, ModelAuthor[]> {
  const result = new Map<string, ModelAuthor[]>();
  const ids = [...new Set(resourceIds.filter(Boolean))];
  if (ids.length === 0 || !modelAuthorshipTableExists(database)) return result;
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const rows = database.prepare(`
      SELECT resource_id, provider, model, MIN(created_at) AS first_authored_at
      FROM honeycrisp_model_authorship
      WHERE resource_kind = ? AND resource_id IN (${batch.map(() => "?").join(",")})
      GROUP BY resource_id, provider, model
      ORDER BY first_authored_at, provider, model
    `).all(resourceKind, ...batch) as Array<{ resource_id: string; provider: string; model: string }>;
    for (const row of rows) {
      const authors = result.get(row.resource_id) ?? [];
      authors.push({ provider: row.provider, model: row.model });
      result.set(row.resource_id, authors);
    }
  }
  return result;
}

export function modelAuthorshipTableExists(database: DatabaseSync): boolean {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'honeycrisp_model_authorship'",
  ).get());
}
