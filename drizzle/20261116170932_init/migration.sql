CREATE TABLE `displays` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text,
	`playlist` text NOT NULL,
	`settings` text NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `layouts` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`settings` text NOT NULL,
	`elements` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`file` text NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`album` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `displays_slug_unique` ON `displays` (`slug`);