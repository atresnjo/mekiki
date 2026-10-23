CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "panels" (
	"repo" text,
	"number" integer,
	"comment_id" bigint NOT NULL,
	CONSTRAINT "panels_pkey" PRIMARY KEY("repo","number")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reviews_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"status" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" integer PRIMARY KEY,
	"data" jsonb NOT NULL,
	CONSTRAINT "settings_one_row" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE INDEX "reviews_pr" ON "reviews" ("repo","number","id");