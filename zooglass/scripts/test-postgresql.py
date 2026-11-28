#!/usr/bin/env python3
"""Run the required PostgreSQL tests against an owned fixture; never build Java."""

import argparse
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import time

IMAGE = "postgres:18.7-bookworm@sha256:e742a2668255221388004f3a42b6150a2103f5054ab3a4a93ae9e4f01e551c35"
SERVICE = Path(__file__).resolve().parents[1]
TEST_NAMES = (
    "io.zooglass.runtime.PostgresStaticStoreIT",
    "io.zooglass.runtime.PostgresOwnershipIT",
    "io.zooglass.access.HaTransportIT",
)
TEST_DIRECTORY = SERVICE / "target/test-classes"


def command(arguments, *, timeout=30, capture=True, check=True, env=None):
    with subprocess.Popen(arguments, cwd=SERVICE, text=True, env=env,
                          start_new_session=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except BaseException:
            # Stop the owned command group, including a Maven/Surefire child JVM.
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
            except ProcessLookupError:
                pass
            raise
        result = subprocess.CompletedProcess(arguments, process.returncode, stdout, stderr)
        if check:
            result.check_returncode()
        return result


def interrupted(signum, _frame):
    raise InterruptedError(f"PostgreSQL fixture interrupted by signal {signum}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-client", action="store_true", help="Run Node client interoperability against the prepared service JAR")
    args = parser.parse_args()
    if args.node_client and not (SERVICE / "target/zooglass.jar").is_file():
        raise RuntimeError("Prepared service JAR missing; prepare it explicitly first")
    if not args.node_client and any(not (TEST_DIRECTORY / (name.replace(".", "/") + ".class")).is_file() for name in TEST_NAMES):
        raise RuntimeError("Prepared PostgreSQL test classes are missing. Run ./mvnw -DskipTests package explicitly first.")
    # A unique owned container; no shared host directories or existing databases.
    name = "zooglass-postgres-test-" + secrets.token_hex(8)
    password = secrets.token_urlsafe(24)
    environment = dict(os.environ, POSTGRES_PASSWORD=password)
    try:
        command(["docker", "create", "--name", name,
                 "--label", "io.zooglass.fixture=postgresql",
                 "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_USER=zooglass",
                 "-e", "POSTGRES_DB=zooglass", "-p", "127.0.0.1::5432", IMAGE],
                timeout=180, env=environment)
        command(["docker", "start", name])
        deadline = time.monotonic() + 45
        while True:
            ready = command(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "zooglass", "-d", "zooglass"],
                            timeout=5, check=False)
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Owned PostgreSQL fixture did not become ready within 45 seconds")
            time.sleep(0.2)
        binding = command(["docker", "port", name, "5432/tcp"]).stdout.strip()
        if not binding.startswith("127.0.0.1:") or "\n" in binding:
            raise RuntimeError("Expected one loopback-only PostgreSQL fixture port")
        port = int(binding.rsplit(":", 1)[1])
        environment.update(
            ZOOGLASS_POSTGRES_URL=f"jdbc:postgresql://127.0.0.1:{port}/zooglass",
            ZOOGLASS_POSTGRES_USER="zooglass",
            ZOOGLASS_POSTGRES_PASSWORD=password,
        )
        version = command(["docker", "exec", name, "psql", "-U", "zooglass", "-d", "zooglass", "-Atc", "SHOW server_version"]).stdout.strip()
        if not version.startswith("18.7 ") and version != "18.7":
            raise RuntimeError("Pinned fixture did not report PostgreSQL 18.7")
        print(f"PostgreSQL fixture: {version}; image {IMAGE}", flush=True)
        suite = (["node", "--import", str(SERVICE.parent / "workbench/node_modules/tsx/dist/loader.mjs"),
                  "--test", str(SERVICE.parent / "workbench/test/ha-service/client.test.ts")]
                 if args.node_client else
                 ["./mvnw", "--batch-mode", "-Dtest=" + ",".join(TEST_NAMES), "surefire:test"])
        result = command(suite,
                         timeout=300, capture=False, check=False, env=environment)
        return result.returncode
    finally:
        # Also try after an ambiguous create result; this unpredictable name belongs to this invocation.
        removed = command(["docker", "rm", "--force", "--volumes", name], check=False)
        if removed.returncode != 0:
            # A failed create may still have created the container on the daemon.
            remaining = command(["docker", "container", "ls", "--all", "--filter",
                                 f"name=^/{name}$", "--format", "{{.Names}}"], check=False)
            if remaining.returncode != 0 or remaining.stdout.strip():
                raise RuntimeError(f"Cleanup of owned fixture {name} is uncertain; inspect Docker before retrying")


if __name__ == "__main__":
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    try:
        sys.exit(main())
    except (RuntimeError, InterruptedError, subprocess.SubprocessError, OSError) as failure:
        print(f"PostgreSQL verification failed: {failure}", file=sys.stderr)
        sys.exit(1)
