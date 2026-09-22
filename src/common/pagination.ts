import { Transform, Type } from "class-transformer";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

export class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize: number = 8;
  @IsOptional() @Transform(({ value }) => (typeof value === "string" ? value.trim() : value)) @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsString() @MaxLength(30) status?: string;
}

export interface Page<T> { data: T[]; total: number; page: number; pageSize: number; }
export const skipTake = (q: ListQuery) => ({ skip: (q.page - 1) * q.pageSize, take: q.pageSize });
export const page = <T>(data: T[], total: number, q: ListQuery): Page<T> => ({ data, total, page: q.page, pageSize: q.pageSize });
