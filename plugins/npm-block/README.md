# npm-block

Rewrites `npm` to `pnpm` in Bash commands, so the call still runs instead of being denied.

- `npm i`, `npm run x`, `/usr/bin/npm …`, `FOO=1 npm test`, `$(npm …)`, `a && npm …` → `pnpm …`
- `npm ci` → `pnpm install --frozen-lockfile`
- `npm` inside quotes, arguments, `pnpm` and `npx` is left alone.
- Repos `cucina-inventory-droppin` and `cucina-inventory-conteo` keep npm (cwd or command mentions them).
- A short toast `npm → pnpm` shows when a rewrite happens.

Gain over the old `npm-block.js` hook: the model's command runs (rewritten) rather than failing and being retried by hand.
Limit: only the command word is swapped; npm-only subcommands (`npm bin`) fail in pnpm with pnpm's own error.

Test: `claude plugin test plugins/npm-block`.
