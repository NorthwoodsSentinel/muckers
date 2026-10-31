# KINTSUGI

Repairs in this repo are marked, not hidden. Each fix carries the same gold line in three
places: a `kintsugi:` comment at the repair site, a `Kintsugi:` trailer on the commit, and a
row here. The ledger is append-only.

A row never claims a review before one exists. The fix commit writes `review pending`; a
separate follow-up commit names the reviewer and the reviewed SHA once the review passes.
Security repairs describe the class of fix, never how to exploit the break.

| Date | What broke | How it was mended | Mended by / reviewed by | Gold line |
|---|---|---|---|---|
| 2026-10-31 | The access token had a published default that a one-click install could keep. | Token is a required secret; the worker refuses placeholder, short or missing tokens; comparison is constant-time. Adversarial suite in `test/gate.test.ts`. | CeeCee / review pending | the door shipped with its key taped to the frame — / now an unset or borrowed key opens nothing, / and the lock no longer tells the hand how near it came. |
