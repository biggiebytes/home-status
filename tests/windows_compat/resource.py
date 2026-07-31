"""Minimal resource-module shim for Home Assistant tests on Windows."""

RLIMIT_NOFILE = 7


def getrlimit(_resource):
    return (2048, 2048)


def setrlimit(_resource, _limits):
    return None
