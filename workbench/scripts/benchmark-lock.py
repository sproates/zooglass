"""Hold one POSIX campaign lock across exec and all explicitly inheriting children."""
import fcntl
import os
import stat
import sys


def lock(directory, inherited=None):
    path = os.path.join(directory, ".lock")
    fd = inherited if inherited is not None else os.open(
        path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600
    )
    actual, named = os.fstat(fd), os.stat(path, follow_symlinks=False)
    if not stat.S_ISREG(named.st_mode) or not os.path.samestat(actual, named):
        raise ValueError("Lock descriptor does not identify this campaign's lock file")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


try:
    if sys.argv[1] == "--check":
        lock(sys.argv[2], 3)
    else:
        directory, executable, *args = sys.argv[1:]
        fd = lock(directory)
        os.set_inheritable(fd, True)
        os.environ["ZOOGLASS_CAMPAIGN_LOCK_FD"] = str(fd)
        os.execvp(executable, [executable, *args])
except BlockingIOError:
    sys.exit("Campaign is still in use by another runner or its service")
except (OSError, ValueError, IndexError) as error:
    sys.exit(str(error))
