import { Module } from "@nestjs/common";
import { FinanceController, WalletController } from "./finance.controller";
import { FinanceService } from "./finance.service";

@Module({ controllers: [FinanceController, WalletController], providers: [FinanceService], exports: [FinanceService] })
export class FinanceModule {}
