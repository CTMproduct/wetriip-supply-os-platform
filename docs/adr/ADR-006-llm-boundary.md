# ADR-006 — The LLM produces intent and nothing else

**Status:** accepted · implemented

## Context

An agentic extranet is only viable if a model misreading a sentence cannot
become 1,000 rooms at USD 1.

## Decision

A model's only permitted output is a value in `StructuredCommandSchema` — a
closed, Zod-validated union of fourteen command kinds. Anything it cannot express, it
cannot do. Model output that fails validation is discarded, and the user is told
what was missing.

A deterministic grammar (Spanish and English) is tried **first**. Not as a cost
optimisation: a phrase the grammar recognises must produce the same command on
every machine, in every test run, forever. The model handles the long tail; the
common path is reproducible and is the regression harness the model is measured
against.

Everything after intent — simulation, policy, confirmation, execution, audit — is
deterministic and identical whether or not a model is configured. The platform
runs, tests and certifies with no API key.

The confirmation sentence a human sees is generated from the computed diff. The
model never describes its own change.

## Consequences

The agent can only do fourteen things. Adding a fifteenth is a deliberate schema
change with a policy path, a simulation path and an inverse for rollback. That
friction is the point.

The grammar needs maintenance in two languages, and utterances it cannot parse
are recorded so the gap is measurable rather than anecdotal.
