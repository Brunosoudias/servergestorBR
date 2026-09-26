import { Module } from "@nestjs/common";
import { FinanceModule } from "../finance/finance.module";
import { FiscalModule } from "../fiscal/fiscal.service";
import { InventoryModule } from "../inventory/inventory.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({ imports: [FinanceModule, InventoryModule, FiscalModule], controllers: [SalesController], providers: [SalesService], exports: [SalesService] })
export class SalesModule {}
