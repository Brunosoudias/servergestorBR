import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { SalesModule } from "../sales/sales.module";
import { PosConfigService } from "./pos-config.service";
import { PosController } from "./pos.controller";
import { PosService } from "./pos.service";
import { ReturnsService } from "./returns.service";

@Module({ imports: [SalesModule, FinanceModule], controllers: [PosController], providers: [PosService, PosConfigService, ReturnsService], exports: [PosService] })
export class PosModule {}
