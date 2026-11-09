import process from 'node:process'
import { defineDshConfig } from '../builtin-plugin-config/src/index.ts'

export default [
  ...defineDshConfig({ client: { noExternal: ['dsh-pet-component', 'fflate'] } }).map(config => ({ ...config, clean: false, dts: process.argv.includes('--watch') ? false : config.dts })),
  {
    entry: { renderer: 'src/renderer/index.tsx' },
    outDir: 'dist/desktop',
    format: 'iife',
    platform: 'browser',
    outputOptions: { entryFileNames: 'renderer.js' },
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    noExternal: [/./],
    dts: false,
    sourcemap: true,
    minify: false,
    clean: false,
    publint: false,
  },
]
