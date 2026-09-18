# Legacy reference tree

Phase 0 repository surgery moved DELETE / REFERENCE ONLY / DEFER code here
from `app/`. Git history is preserved via `git mv`.

This tree is **not** compiled, typechecked, or imported by the active
application under `app/`. Read it when extracting a KEEP/EXTRACT kernel into
the target graph. Do not add imports from `app/src` into these files, and do
not import these files from `app/src`.
