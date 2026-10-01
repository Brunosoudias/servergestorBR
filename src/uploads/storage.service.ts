import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { mkdir, readdir, stat, writeFile } from "fs/promises";
import { join } from "path";
import { ENV, type Env } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import { PLAN_LIMITS } from "../common/plans";

async function dirSize(dir: string): Promise<number> {
  try {
    let total = 0;
    for (const e of await readdir(dir, { withFileTypes: true })) total += e.isDirectory() ? await dirSize(join(dir, e.name)) : (await stat(join(dir, e.name))).size;
    return total;
  } catch { return 0; }
}

/** Grava arquivos no disco local (uma instância) ou em S3/R2/MinIO (várias instâncias) e controla a cota do plano. */
@Injectable()
export class StorageService {
  private readonly s3: S3Client | null;

  constructor(private readonly prisma: PrismaService, @Inject(ENV) private readonly env: Env) {
    const s = env.storage;
    this.s3 = s.driver === "s3" ? new S3Client({ region: s.region, endpoint: s.endpoint, forcePathStyle: s.forcePathStyle }) : null;
  }

  /** Bytes usados pela empresa. No disco local, arquivos enviados antes do contador são somados uma única vez. */
  async usedBytes(orgId: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { storageBytes: true } });
    if (org.storageBytes > 0n || this.env.storage.driver !== "local") return Number(org.storageBytes);
    const legacy = await dirSize(join(this.env.uploadDir, orgId));
    if (legacy > 0) await this.prisma.organization.updateMany({ where: { id: orgId, storageBytes: 0n }, data: { storageBytes: BigInt(legacy) } });
    return legacy;
  }

  async put(orgId: string, name: string, body: Buffer, contentType: string) {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { plan: true } });
    const limit = PLAN_LIMITS[org.plan].storageGb * 1024 ** 3;
    if ((await this.usedBytes(orgId)) + body.length > limit) {
      throw new HttpException(`O armazenamento do plano (${PLAN_LIMITS[org.plan].storageGb} GB) está cheio. Remova imagens ou mude de plano.`, HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const key = `${orgId}/${name}`;
    let url: string;
    if (this.s3 && this.env.storage.driver === "s3") {
      const s = this.env.storage;
      await this.s3.send(new PutObjectCommand({ Bucket: s.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: "public, max-age=2592000, immutable" }));
      url = `${s.publicUrl ?? `https://${s.bucket}.s3.${s.region}.amazonaws.com`}/${key}`;
    } else {
      await mkdir(join(this.env.uploadDir, orgId), { recursive: true });
      await writeFile(join(this.env.uploadDir, key), body);
      url = `${this.env.apiUrl}/uploads/${key}`;
    }
    await this.prisma.organization.update({ where: { id: orgId }, data: { storageBytes: { increment: BigInt(body.length) } } });
    return url;
  }
}
