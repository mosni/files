// E8 Wave C1: the admin read - every ACL row across both tables, with NO expiry filter (D-216/D-218). The
// panel shows expired rows too; the authorization reads (storage/aclPredicates.ts) are the ones that
// filter. `status` is computed in SQL so a client clock never decides whether access is live.

import type { RowDataPacket } from "mysql2/promise";
import { getPool } from "./db.ts";

export type GrantStatus = "active" | "expired";

export type AdminGrant = {
  targetType: "file" | "collection";
  targetId: string;
  targetName: string;
  ownerSub: string | null;
  sub: string;
  canUpload: boolean;
  grantedAt: Date;
  expiresAt: Date | null;
  status: GrantStatus;
};

interface GrantRow extends RowDataPacket {
  target_type: "file" | "collection";
  target_id: string;
  target_name: string;
  owner_sub: string | null;
  sub: string;
  can_upload: number;
  granted_at: Date;
  expires_at: Date | null;
  status: GrantStatus;
}

function rowToGrant(row: GrantRow): AdminGrant {
  return {
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    ownerSub: row.owner_sub,
    sub: row.sub,
    canUpload: row.can_upload === 1,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

// `can_upload` does not exist on file_acl (a file grant is always view-only) - selected as a literal 0 for
// that half of the union, matching the plan's shared contract exactly.
export async function listAllGrants(): Promise<AdminGrant[]> {
  const [rows] = await getPool().query<GrantRow[]>(
    `SELECT * FROM (
       SELECT 'file' AS target_type, fa.file_id AS target_id, f.name AS target_name, f.owner_sub AS owner_sub,
              fa.sub AS sub, 0 AS can_upload, fa.granted_at AS granted_at, fa.expires_at AS expires_at,
              CASE WHEN fa.expires_at IS NOT NULL AND fa.expires_at <= NOW() THEN 'expired' ELSE 'active' END AS status
         FROM file_acl fa JOIN files f ON f.id = fa.file_id
       UNION ALL
       SELECT 'collection' AS target_type, ca.collection_id AS target_id, c.name AS target_name, c.owner_sub AS owner_sub,
              ca.sub AS sub, ca.can_upload AS can_upload, ca.granted_at AS granted_at, ca.expires_at AS expires_at,
              CASE WHEN ca.expires_at IS NOT NULL AND ca.expires_at <= NOW() THEN 'expired' ELSE 'active' END AS status
         FROM collection_acl ca JOIN collections c ON c.id = ca.collection_id
     ) AS grants
     ORDER BY granted_at DESC`,
  );
  return rows.map(rowToGrant);
}
