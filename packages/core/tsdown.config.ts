import { defineConfig } from 'tsdown'

const entry = [
	'src/entry-dev.ts',
	'src/entry-prod.ts',
	'src/types.ts',
	'src/vite/index.ts',
	'src/template-diagnostics-api.ts',
	'src/compile-check-api.ts',
	'src/nitro/runtime-plugin.ts',
	'src/routing/route-manifest.ts',
	'src/routing/route-typegen.ts',
	'src/utils/aliases.ts',
	'src/utils/redirects.ts',
	'src/runtime/index.ts',
	'src/runtime/standalone.ts',
	'src/runtime/fragment.ts',
	'src/runtime/instance.ts',
	'src/utils/aero-config.ts',
	'src/config-api.ts',
	'src/vite-config-api.ts',
	'src/utils/load-project-module.ts',
]

export default defineConfig({
	entry,
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
	deps: {
		neverBundle: [
			'@content/site.ts',
			'@aero-js/diagnostics',
			'virtual:aero/state-bindings-registry.ts',
			'nitro',
			'nitro/h3',
			'consola',
			'youch',
			'youch-core',
		],
	},
})
