// Flat config. The rules worth having are the ones `tsc` cannot see and that
// AGENTS.md states by hand. Anything the typechecker already fails on is
// not repeated here: `pnpm typecheck` is the gate that catches it.
//
// Every `off` below is a convention this repo made on purpose, with the reason
// written next to it. None of them was silenced to avoid editing code.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, the design bundle (reviewed, not linted) and `extras/`,
    // which is data and deliberately outside tsconfig, so no program covers it.
    ignores: ['dist/', 'release/', 'design/', 'extras/', 'node_modules/'],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: {
        // Reads tsconfig.json, and covers the handful of files outside its
        // `include` without a second tsconfig to keep in step with the first.
        projectService: { allowDefaultProject: ['vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // AGENTS.md, "Conventions": no default exports. A named export is
      // greppable and cannot be silently renamed at the import site. Written as
      // a core selector rather than pulling eslint-plugin-import-x, whose only
      // other rule worth having here (`order`) is turned down below anyway and
      // which drags in a native postinstall binary for module resolution.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'No default exports. Export a named binding instead.',
        },
      ],

      // `verbatimModuleSyntax` is on, so a type imported without `type` is
      // emitted as a real import. tsc does not require the keyword; this does.
      // `disallowTypeAnnotations` is off: an inline `import('…')` in a type
      // position emits nothing, so the rule's reason does not reach it.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',

      // Matches what `noUnusedParameters` already does: a leading underscore is
      // how this repo says "required by the signature, unused on purpose", and
      // `src/lib/handlers.ts` is full of `_settings`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // `let x; … x = …` where the closure above x reads it. `const` is not
      // available there, so the default reading of "never reassigned" is wrong.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    },
  },

  {
    // ---- Rules turned off, and why ----
    files: ['**/*.ts', '**/*.mts'],
    rules: {
      // Every hit is `Object.assign(Object.create(null), …)`, which is this
      // repo's prototype-pollution defence: a shortcut id is a key off
      // untrusted JSON, so the maps holding them are null-prototype on purpose
      // (AGENTS.md invariant 17). `Object.create` is typed `any`, so the rule
      // fires on exactly the code that exists to be safe.
      '@typescript-eslint/no-unsafe-assignment': 'off',

      // `@types/chrome` models `details.reason` as an enum, and comparing it to
      // `'install'` is the documented Chrome idiom and what every call site
      // here does. The enum members are those strings.
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',

      // The three hits are assertions at a trust boundary that narrow input the
      // typechecker happens to have already narrowed. They document what the
      // code assumes about a `?raw` blob or a `sendMessage` reply; deleting
      // them would make the module depend silently on inference.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },

  {
    // Vite and Vitest load their config through a default export. There is no
    // named form, so the rule is off here rather than the files being changed.
    files: ['vite.config.ts', 'vitest.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    files: ['tests/**/*.ts'],
    rules: {
      // The suites hand hostile, deliberately untyped blobs to the storage and
      // import boundaries: that is what invariants 16 and 17 are tested with.
      // A fixture that had to typecheck could not express the shapes the parser
      // exists to refuse.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',

      // `tests/helpers/rules.ts` stubs promise-returning chrome APIs. The stubs
      // must be `async` to match the signature they replace, and none of them
      // has anything to await.
      '@typescript-eslint/require-await': 'off',

      // `declare const globalThis: { chrome?: unknown }` in tests/url.test.ts
      // is a type declaration, not a binding that shadows anything at runtime.
      'no-shadow-restricted-names': 'off',
    },
  },

  {
    // ---- Left on, and currently warning ----
    // `preserve-caught-error` wants `{ cause: err }` on the error thrown from
    // the JSON catch in src/lib/storage/parse-import.ts. That is a fair
    // suggestion rather than a convention to overrule, so it stays visible as a
    // warning instead of being switched off. Nothing reads `.cause` today and
    // the message already interpolates the underlying text, so the fix is
    // somebody's call, not this config's.
    files: ['**/*.ts', '**/*.mts'],
    rules: { 'preserve-caught-error': 'warn' },
  },

  {
    // This file. It default-exports because that is how flat config is loaded,
    // and no TypeScript program covers it.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    // Plain Node scripts. tsconfig has `allowJs` off, so no program covers
    // them and the type-aware rules have nothing to read.
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
