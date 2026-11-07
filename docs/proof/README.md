# Failover proof

A run on 2026-11-07, in a throwaway git repo, on a Mac.

- **Simulated:** the limit. Claude's limit error was written by hand and passed to nowall's real `StopFailure` hook, because hitting a real limit on demand isn't possible.
- **Real:** everything after that. nowall's hook, checkpoints and takeover ran as shipped, and the signed-in Cursor CLI made the edit (`multiply` in `math.js`) in about 36 seconds.
- **Images:** the notch's own renderer drawing that run's status files, not screenshots of the desktop.

`failover-switching.png` is during the handoff, `failover-done.png` is after it, and `failover-log.txt` is the takeover log.
