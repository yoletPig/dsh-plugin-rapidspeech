/** Bundle the browser half into the ModuleLoader registration the dsh web client expects. */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../src/client-ui.ts', import.meta.url))
const out = fileURLToPath(new URL('../lib/browser.js', import.meta.url))

// The web module system registers each package's client.js factory by package name;
// `react` and friends come from the platform seed, so they stay external requires.
await build({
  entryPoints: [src],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  legalComments: 'none',
  outfile: out,
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "dsh-plugin-rapidspeech",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
      '    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    ].join('\n'),
  },
  footer: { js: '\n    return module.exports;\n  }\n});' },
})
