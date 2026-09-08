"""Linux child containment: kill the exact child if its Node guardian dies."""
import ctypes
import os
import signal
import sys

expected_parent = int(sys.argv[1])
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise SystemExit(71)
# Covers the race where the parent exits before prctl has taken effect.
if os.getppid() != expected_parent:
    raise SystemExit(72)
os.execv(sys.argv[2], sys.argv[2:])
