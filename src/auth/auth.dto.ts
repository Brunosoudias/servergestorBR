import { Transform } from "class-transformer";
import { IsEmail, IsString, Matches, MaxLength, MinLength } from "class-validator";

const lower = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;
const PASSWORD_MSG = "A senha deve ter de 8 a 72 caracteres, com letras e números.";

export class LoginDto {
  @Transform(lower) @IsEmail({}, { message: "Informe um e-mail válido." }) email: string;
  @IsString({ message: "Informe a senha." }) @MaxLength(72, { message: "Senha inválida." }) password: string;
}

export class RegisterDto {
  @Transform(trim) @IsString() @MinLength(2, { message: "Informe seu nome." }) @MaxLength(80) name: string;
  @Transform(lower) @IsEmail({}, { message: "Informe um e-mail válido." }) @MaxLength(160) email: string;
  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MSG }) password: string;
}

export class ForgotPasswordDto {
  @Transform(lower) @IsEmail({}, { message: "Informe um e-mail válido." }) email: string;
}

export class ResetPasswordDto {
  @IsString() @MinLength(20, { message: "Link inválido ou expirado." }) @MaxLength(200) token: string;
  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MSG }) password: string;
}
