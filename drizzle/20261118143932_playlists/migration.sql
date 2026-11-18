CREATE TABLE `playlists` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`entries` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `displays` ADD `playlist_id` text;