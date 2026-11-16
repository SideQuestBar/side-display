ALTER TABLE `displays` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `layouts` ADD `folder` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `layouts` ADD `archived_at` integer;