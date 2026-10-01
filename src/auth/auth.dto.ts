import { Transform } from "class-transformer";
import { IsEmail, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { PASSWORD_MSG, PASSWORD_RULE } from "../common/password";

const lower = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().toLowerCase() : value);
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

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

const MFA_CODE_MSG = "Informe o código de 6 dígitos do app autenticador.";
const SECOND_FACTOR_RE = /^(\d{6}|[A-Za-z2-7]{5}-[A-Za-z2-7]{5})$/;
const SECOND_FACTOR_MSG = "Informe o código de 6 dígitos do app ou um código de recuperação (xxxxx-xxxxx).";

export class MfaVerifyDto {
  @IsString() @MinLength(20, { message: "A verificação expirou. Entre novamente." }) @MaxLength(200) challenge: string;
  @Transform(trim) @IsString() @Matches(SECOND_FACTOR_RE, { message: SECOND_FACTOR_MSG }) code: string;
}

export class MfaCodeDto {
  @Transform(trim) @IsString() @Matches(/^\d{6}$/, { message: MFA_CODE_MSG }) code: string;
}

export class MfaDisableDto {
  @Transform(trim) @IsString() @Matches(SECOND_FACTOR_RE, { message: SECOND_FACTOR_MSG }) code: string;
  @IsString({ message: "Informe a senha." }) @MinLength(1, { message: "Informe a senha." }) @MaxLength(72) password: string;
}

export class ChangePasswordDto {
  @IsString({ message: "Informe a senha atual." }) @MinLength(1, { message: "Informe a senha atual." }) @MaxLength(72) currentPassword: string;
  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MSG }) password: string;
}

export class ResetPasswordDto {
  @IsString() @MinLength(20, { message: "Link inválido ou expirado." }) @MaxLength(200) token: string;
  @IsString() @Matches(PASSWORD_RULE, { message: PASSWORD_MSG }) password: string;
}
