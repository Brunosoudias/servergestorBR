import { Transform } from "class-transformer";
import { IsEmail, IsOptional, IsString, Length, MaxLength, MinLength, Validate, ValidatorConstraint, ValidatorConstraintInterface } from "class-validator";
import { isValidCnpj } from "../common/cnpj";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

@ValidatorConstraint({ name: "cnpj" })
class CnpjConstraint implements ValidatorConstraintInterface {
  validate(v: unknown) { return typeof v === "string" && isValidCnpj(v); }
  defaultMessage() { return "CNPJ inválido."; }
}

export class CompanyDto {
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe o nome da empresa." }) @MaxLength(120) name: string;
  @Validate(CnpjConstraint) cnpj: string;
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value)) @IsEmail({}, { message: "Informe um e-mail válido." }) email: string;
  @Transform(trim) @IsString() @MaxLength(30) phone: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) address?: string;
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe a cidade." }) @MaxLength(80) city: string;
  @Transform(trim) @IsString() @Length(2, 2, { message: "Informe a UF com 2 letras." }) state: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) segment?: string;
}
