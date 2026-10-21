CREATE TABLE "skyfarm_columns" (
	"user_id" text NOT NULL,
	"cx" integer NOT NULL,
	"cz" integer NOT NULL,
	"hash" text NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "skyfarm_columns_user_id_cx_cz_pk" PRIMARY KEY("user_id","cx","cz")
);
--> statement-breakpoint
CREATE TABLE "skyfarm_islands" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"save_version" integer NOT NULL,
	"island" jsonb,
	"map" "bytea",
	"bytes" integer DEFAULT 0 NOT NULL,
	"trusted" jsonb,
	"rates" jsonb,
	"rates_for" text,
	"bought" integer,
	"ore" integer,
	"saved_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skyfarm_islands_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "skyfarm_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"item" text NOT NULL,
	"side" text NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"quantity" integer NOT NULL,
	"filled" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skyfarm_storage" (
	"user_id" text NOT NULL,
	"item" text NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "skyfarm_storage_user_id_item_pk" PRIMARY KEY("user_id","item")
);
--> statement-breakpoint
CREATE TABLE "skyfarm_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"item" text NOT NULL,
	"buyer_id" text,
	"seller_id" text,
	"price" numeric(19, 4) NOT NULL,
	"quantity" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skyfarm_columns" ADD CONSTRAINT "skyfarm_columns_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skyfarm_islands" ADD CONSTRAINT "skyfarm_islands_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skyfarm_orders" ADD CONSTRAINT "skyfarm_orders_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skyfarm_storage" ADD CONSTRAINT "skyfarm_storage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skyfarm_trades" ADD CONSTRAINT "skyfarm_trades_buyer_id_user_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skyfarm_trades" ADD CONSTRAINT "skyfarm_trades_seller_id_user_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skyfarm_columns_user_hash_idx" ON "skyfarm_columns" USING btree ("user_id","hash");--> statement-breakpoint
CREATE INDEX "skyfarm_orders_book_idx" ON "skyfarm_orders" USING btree ("item","status","side","price");--> statement-breakpoint
CREATE INDEX "skyfarm_orders_user_idx" ON "skyfarm_orders" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "skyfarm_trades_item_createdAt_idx" ON "skyfarm_trades" USING btree ("item","created_at");--> statement-breakpoint
CREATE INDEX "skyfarm_trades_buyer_idx" ON "skyfarm_trades" USING btree ("buyer_id");--> statement-breakpoint
CREATE INDEX "skyfarm_trades_seller_idx" ON "skyfarm_trades" USING btree ("seller_id");