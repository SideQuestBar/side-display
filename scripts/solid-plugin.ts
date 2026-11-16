/**
 * Bun bundler plugin that compiles SolidJS JSX (.tsx/.jsx) with Babel.
 * Bun's own JSX transform is React-flavoured; Solid needs dom-expressions to
 * keep its fine-grained reactivity, so client files go through babel here.
 * Registered in bunfig.toml (dev server) and used by scripts/build.ts.
 */

import { transformAsync } from "@babel/core";
import ts from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { BunPlugin } from "bun";

const plugin: BunPlugin = {
	name: "solid",
	setup(build) {
		build.onLoad({ filter: /\/src\/client\/.*\.[jt]sx$/ }, async (args) => {
			const source = await Bun.file(args.path).text();
			const result = await transformAsync(source, {
				filename: args.path,
				babelrc: false,
				configFile: false,
				sourceMaps: "inline",
				presets: [
					[ts, {}],
					[solid, { generate: "dom", hydratable: false }],
				],
			});
			return { contents: result?.code ?? "", loader: "js" };
		});
	},
};

export default plugin;
