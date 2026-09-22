import { Global, Inject, Injectable, Module, ServiceUnavailableException } from "@nestjs/common";
import { ENV, type Env } from "../config/env";

@Injectable()
export class IntegrationsService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get sandbox() { return this.env.integrations === "sandbox"; }

  requireSandbox(what: string): void {
    if (!this.sandbox) throw new ServiceUnavailableException(`${what} ainda não está configurado(a) neste ambiente. Contrate e configure o provedor para liberar esta função.`);
  }
}

@Global()
@Module({ providers: [IntegrationsService], exports: [IntegrationsService] })
export class IntegrationsModule {}
