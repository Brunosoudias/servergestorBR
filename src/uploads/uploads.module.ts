import { BadRequestException, Controller, HttpCode, Inject, Module, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { randomBytes } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, RequirePermission } from "../common/decorators";
import { ENV, type Env } from "../config/env";

const MAX_BYTES = 2 * 1024 * 1024;

function detect(buf: Buffer): "png" | "jpg" | "webp" | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

@Controller("uploads")
export class UploadsController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @RequirePermission("products:edit") @HttpCode(201) @Post("image")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async image(@Auth() ctx: AuthContext, @UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) throw new BadRequestException("Selecione uma imagem para enviar.");
    const ext = detect(file.buffer);
    if (!ext) throw new BadRequestException("Formato de imagem não aceito. Envie um arquivo PNG, JPG ou WebP.");
    const orgId = orgOf(ctx);
    const dir = join(resolve(this.env.uploadDir), orgId);
    await mkdir(dir, { recursive: true });
    const name = `${randomBytes(16).toString("hex")}.${ext}`;
    await writeFile(join(dir, name), file.buffer);
    return { url: `${this.env.apiUrl}/uploads/${orgId}/${name}` };
  }
}

@Module({ controllers: [UploadsController] })
export class UploadsModule {}
