import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Response } from "express";
import { currentRequestId } from "../request-context";

const DEFAULTS: Record<number, string> = {
  400: "Dados inválidos.",
  401: "Sua sessão expirou. Faça login novamente.",
  403: "Você não possui permissão para realizar esta ação.",
  404: "Registro não encontrado.",
  409: "Conflito: o registro já existe ou foi alterado.",
  413: "O envio é grande demais. Se for uma imagem, use um arquivo de até 2 MB.",
  402: "Seu período de teste terminou. Escolha um plano para continuar.",
  429: "Muitas tentativas. Aguarde um instante e tente novamente.",
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("Exceptions");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = "Não foi possível concluir a operação. Tente novamente.";
    let errors: string[] | undefined;
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const raw = typeof body === "string" ? body : (body as { message?: string | string[] }).message;
      if (typeof body === "object" && typeof (body as { code?: unknown }).code === "string") code = (body as { code: string }).code;
      if (Array.isArray(raw)) { errors = raw; message = raw[0] ?? DEFAULTS[400]; }
      else if (status === 404 && typeof raw === "string" && raw.startsWith("Cannot ")) {
        message = "Este recurso ainda não está disponível nesta versão."; code = "unavailable";
      }
      else if (status === 413 && (!raw || /too large/i.test(raw))) message = DEFAULTS[413];
      else if (raw && !/^(Unauthorized|Forbidden|Not Found|Bad Request|Conflict|Too Many Requests)$/i.test(raw)) message = raw;
      else message = DEFAULTS[status] ?? message;
    } else if ((exception as { status?: number })?.status === 413) {
      status = 413; message = DEFAULTS[413];
    } else if ((exception as { type?: string })?.type === "entity.parse.failed") {
      status = 400; message = DEFAULTS[400];
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2002") { status = 409; message = DEFAULTS[409]; }
      else if (exception.code === "P2025") { status = 404; message = DEFAULTS[404]; }
      else this.log.error(`[${currentRequestId() ?? "-"}] ${exception.code}: ${exception.message}`);
    } else {
      this.log.error(`[${currentRequestId() ?? "-"}] ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}`);
    }
    const requestId = status >= 500 ? currentRequestId() : undefined;
    res.status(status).json({ statusCode: status, message, ...(code ? { code } : {}), ...(errors ? { errors } : {}), ...(requestId ? { requestId } : {}) });
  }
}
