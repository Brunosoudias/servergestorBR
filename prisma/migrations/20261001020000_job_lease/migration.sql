CREATE TABLE "JobLease" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "lockedUntil" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "JobLease_pkey" PRIMARY KEY ("name")
);
