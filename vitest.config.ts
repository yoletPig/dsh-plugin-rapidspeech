import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // NodeNext TS: source imports use `.js` suffixes that map to `.ts` files here.
    extensionAlias: { '.js': ['.ts', '.js'] },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
