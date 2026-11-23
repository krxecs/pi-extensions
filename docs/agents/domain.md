# Domain docs

The engineering skills use a multi-context layout for this repo.

## Before exploring

- Read the root `GLOSSARY-MAP.md`, then each package glossary it points to that is relevant to the task.
- Read relevant shared ADRs in `docs/adr/` and package ADRs in `packages/<package>/docs/adr/`.

If a file or directory does not exist, continue without flagging it. `/domain-modeling` creates glossaries and ADRs as terms and decisions are settled.

## Layout

- `GLOSSARY-MAP.md` points to `packages/<package>/GLOSSARY.md`.
- `docs/adr/` holds decisions shared across packages.
- `packages/<package>/docs/adr/` holds package-specific decisions.

## Vocabulary and decisions

Use glossary terms in issues, proposals, hypotheses, and tests. If a needed concept is missing, reconsider the term or note the gap for `/domain-modeling`. If a proposal conflicts with an ADR, identify the ADR and explain the conflict.
