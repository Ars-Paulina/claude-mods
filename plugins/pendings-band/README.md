# pendings-band

One line above the prompt with the next ready step ("pending") for the project you are in. Steps come from a small local goal ledger that the bundled `scripts/goals.py` keeps in `~/.claude/goal-ledger/`. The band only reads it.

Needs Python 3.9+ (`python3`, `python` or `py -3`).

## Install

```
/plugin install pendings-band --marketplace Ars-Paulina/claude-mods
```

During install, set **Folder to ledger project map**, for example `~/code/shop=shop;~/code/blog=blog`. A folder matches itself and its subfolders.

## Start a ledger

Until a ledger exists the band shows `no goal ledger yet`. From the plugin folder (`/plugin` shows where it is installed):

```bash
# 1. An outcome: one sentence that is true when the work is done, and the projects it spans
python3 scripts/goals.py outcome-create --statement "The shop takes card payments" --projects shop

# 2. A spec file with a pendings table between the two sentinel lines
cat > spec.md <<'MD'
%%PENDINGS:BEGIN%%
| id | description | depends on | status |
|----|----|----|----|
| P01 | Add the payment form to the checkout page. | - | open |
| P02 | Send the receipt email after a payment. | P01 | open |
%%PENDINGS:END%%
MD

# 3. Load the table into the outcome
python3 scripts/goals.py pendings-ingest --outcome outcome-0001 --spec spec.md

# Mark a step done (updates the spec file and the ledger)
python3 scripts/goals.py pendings-set --outcome outcome-0001 --spec spec.md --row P01 --status done
```

Descriptions must be full sentences ending in a period. Statuses: `open`, `active`, `blocked`, `done`. `python3 scripts/goals.py --help` lists every command.

Optional: set `GOALS_VAULT_PROJECTS` to a notes folder (one subfolder per project) to turn on the vault features of `goals.py`. Unset, they stay off.
