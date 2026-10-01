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
  405: "Esta ação não está disponível.",
  408: "O servidor demorou para responder. Tente novamente.",
  415: "Formato de envio não aceito.",
  422: "Não foi possível processar os dados informados.",
  429: "Muitas tentativas. Aguarde um instante e tente novamente.",
  503: "Serviço temporariamente indisponível. Tente novamente em instantes.",
};
const GENERIC = "Não foi possível concluir a operação. Tente novamente.";

/** Mensagens do framework/bibliotecas (em inglês ou com detalhes internos) nunca chegam ao cliente. */
const TECHNICAL = /exception|error|validation failed|unexpected|json|cannot |undefined|null|expected|multipart|boundary|too (many|large|long)|prisma|sql|stack|^(unauthorized|forbidden|not found|bad request|conflict|payload too large|unprocessable entity|method not allowed|internal server error|service unavailable|request timeout|unsupported media type|gone|not acceptable)$/i;
const isSafe = (m: unknown): m is string => typeof m === "string" && m.trim() !== "" && !TECHNICAL.test(m);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger("Exceptions");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = GENERIC;
    let errors: string[] | undefined;
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const raw = typeof body === "string" ? body : (body as { message?: string | string[] }).message;
      if (typeof body === "object" && typeof (body as { code?: unknown }).code === "string") code = (body as { code: string }).code;
      const fallback = DEFAULTS[status] ?? (status >= 500 ? GENERIC : DEFAULTS[400]);
      if (Array.isArray(raw)) {
        const safe = raw.filter(isSafe);
        if (safe.length) errors = safe;
        message = safe[0] ?? fallback;
      }
      else if (status === 404 && typeof raw === "string" && raw.startsWith("Cannot ")) {
        message = "Este recurso ainda não está disponível nesta versão."; code = "unavailable";
      }
      else if ((status < 500 || status === 503) && isSafe(raw)) message = raw;
      else message = fallback;
      if (status >= 500 && status !== 503) this.log.error(`[${currentRequestId() ?? "-"}] ${status}: ${typeof raw === "string" ? raw : JSON.stringify(raw)}`);
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
