"""Minimal import shim for running Home Assistant's test harness on Windows.

Home Assistant production installs are Linux-based. The release-candidate
tests do not exercise its process lock, but homeassistant.runner imports
fcntl while the pytest plugin initializes.
"""

LOCK_EX = 2
LOCK_NB = 4


def flock(_file_descriptor, _operation):
    """No-op process lock used only by the isolated Windows test harness."""
