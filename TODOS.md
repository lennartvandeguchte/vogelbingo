# TODOS

Deferred items from [docs/PLAN.md](docs/PLAN.md). Not scheduled; recorded so later
design does not block them.

## P2 — Findability rating per species (effort: M)

A hand-set field in `data/birds.json` marking heard-only, skulking and flyover-only
birds. Tjiftjaf is a top-3 species in Amsterdam in May because birders identify it by
call; a kid will never tick a chiffchaff. Occurrence count measures presence, not
visibility. The adaptive radius removes statistical noise; this addresses the
narrower biological problem. Revisit after real cards exist.

## P3 — Post-walk feedback loop (effort: L)

The card URL asking "which of these did you actually see?", accumulating a dataset of
what casual walkers spot, which nobody has. The only idea in the planning session that
compounds. Prerequisite is users, not code. Needs an AVG/privacy statement before any
data is collected.

## P3 — Real PDF export (effort: M)

`window.print()` was chosen for zero dependencies and better typography. A PDF file is
the upgrade if phone users turn out to want something to send to a printer. Wait for
the complaint.
