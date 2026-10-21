import { createHash, randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import { enforce, privateKey } from "../../../platform/abuse";
import type { Config } from "../../../platform/config";
import type { Database } from "../../../platform/db";
import { AppError } from "../../../platform/errors";
import type { IdentitySession } from "../contracts";
import { assertMutationSession } from "../session";
import { readAvatar } from "./input";
import { avatarPath } from "./limits";
import { type AvatarProcessor, processAvatar } from "./processor";

export function createAvatarService(
  config: Pick<Config, "API_ORIGIN" | "ABUSE_SECRET">,
  db: Database,
  processImage: AvatarProcessor = processAvatar,
) {
  const url = (version: string) => new URL(`${avatarPath}/${version}.webp`, config.API_ORIGIN).href;
  async function mutate<T>(identity: IdentitySession, effect: (tx: TransactionSql) => Promise<T>) {
    return db.sql.begin(async (tx) => {
      const [account] =
        await tx`SELECT lifecycle FROM auth_user WHERE id=${identity.user.id} FOR UPDATE`;
      if (account?.lifecycle !== "active") throw new AppError("account_unavailable", 403);
      await assertMutationSession(tx, identity.user.id, identity.session.id);
      return effect(tx);
    });
  }
  return {
    async profile(userId: string) {
      const [avatar] =
        await db.sql`SELECT a.version FROM account_avatar a JOIN auth_user u ON u.id=a.user_id
        WHERE a.user_id=${userId} AND u.lifecycle='active'`;
      return { avatar_url: avatar ? url(String(avatar.version)) : null };
    },
    async export(userId: string) {
      const [avatar] =
        await db.sql`SELECT a.version,a.content,a.width,a.height FROM account_avatar a JOIN auth_user u ON u.id=a.user_id
        WHERE a.user_id=${userId} AND u.lifecycle='active'`;
      return {
        avatar_url: avatar ? url(String(avatar.version)) : null,
        avatar: avatar
          ? {
              media_type: "image/webp",
              width: avatar.width,
              height: avatar.height,
              encoding: "base64",
              data: Buffer.from(avatar.content).toString("base64"),
            }
          : null,
      };
    },
    async get(identity: IdentitySession, version: string) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version))
        throw new AppError("avatar_not_found", 404);
      const [avatar] =
        await db.sql`SELECT a.content,a.sha256 FROM account_avatar a JOIN auth_user u ON u.id=a.user_id
        JOIN auth_session s ON s.user_id=u.id AND s.id=${identity.session.id} AND s.expires_at>clock_timestamp()
        WHERE a.user_id=${identity.user.id} AND a.version=${version}::uuid AND u.lifecycle='active'`;
      if (!avatar) throw new AppError("avatar_not_found", 404);
      return { bytes: Buffer.from(avatar.content), etag: `"${avatar.sha256}"` };
    },
    async upload(identity: IdentitySession, request: Request) {
      await enforce(
        db,
        privateKey(config.ABUSE_SECRET, "avatar-upload", identity.user.id),
        3600,
        6,
      );
      const original = await readAvatar(request);
      const bytes = await processImage(original, request.signal);
      const version = randomUUID();
      const digest = createHash("sha256").update(bytes).digest("hex");
      await mutate(identity, async (tx) => {
        if (request.signal.aborted) throw new AppError("request_timeout", 408);
        await tx`INSERT INTO account_avatar(user_id,version,content,sha256) VALUES (${identity.user.id},${version},${bytes},${digest})
          ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,content=excluded.content,sha256=excluded.sha256,updated_at=clock_timestamp()`;
        await tx`UPDATE auth_user SET updated_at=clock_timestamp() WHERE id=${identity.user.id}`;
      });
      return { avatar_url: url(version) };
    },
    async remove(identity: IdentitySession) {
      await mutate(identity, async (tx) => {
        await tx`DELETE FROM account_avatar WHERE user_id=${identity.user.id}`;
        await tx`UPDATE auth_user SET updated_at=clock_timestamp() WHERE id=${identity.user.id}`;
      });
      return { avatar_url: null };
    },
  };
}
export type AvatarService = ReturnType<typeof createAvatarService>;
