import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { InventoryModule } from "../inventory/inventory.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({ imports: [FinanceModule, InventoryModule], controllers: [SalesController], providers: [SalesService], exports: [SalesService] })
export class SalesModule {}
