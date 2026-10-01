import { BadRequestException, Controller, HttpCode, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle } from "@nestjs/throttler";
import { randomBytes } from "crypto";
import { type AuthContext, orgOf } from "../common/auth-context";
import { Auth, RequirePermission } from "../common/decorators";
import { StorageService } from "./storage.service";

const MIME = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" } as const;

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function detectImage(b: Buffer): "png" | "jpg" | "webp" | null {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return null;
}

@Controller("uploads")
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  @RequirePermission("products:edit")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(201)
  @Post("image")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  async image(@Auth() ctx: AuthContext, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException("Selecione uma imagem para enviar.");
    const ext = detectImage(file.buffer);
    if (!ext) throw new BadRequestException("Formato de imagem não aceito. Envie um arquivo PNG, JPG ou WebP.");
    const name = `${randomBytes(16).toString("hex")}.${ext}`;
    return { url: await this.storage.put(orgOf(ctx), name, file.buffer, MIME[ext]) };
  }
}
