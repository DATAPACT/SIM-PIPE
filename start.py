#!/usr/bin/env python3

import argparse
import os
import platform
import subprocess
import sys
import time

# Local imports are placed after the PATH modification below so that the
# correct Homebrew binaries are on PATH before any subprocesses are spawned.
# On macOS, prefer the native arm64 Homebrew over the legacy Rosetta one.
# We check the actual hardware arch via sysctl rather than platform.machine(),
# because Python itself may be running under Rosetta (reporting x86_64).
if platform.system() == "Darwin":
    native_brew_bin = "/opt/homebrew/bin"
    path = os.environ.get("PATH", "")
    if native_brew_bin not in path.split(os.pathsep):
        os.environ["PATH"] = native_brew_bin + os.pathsep + path

from checklist import check_cluster_status, check_simpipe_pods_health
from install import ensure_kubeconfig_env, install_or_upgrade_simpipe
from install import main as install_main


def get_hardware_arch():
    """Return the real hardware architecture, bypassing Rosetta emulation.

    hw.machine lies when the calling process runs under Rosetta; use
    hw.optional.arm64 instead, which always reflects the physical CPU.
    """
    if platform.system() == "Darwin":
        try:
            result = subprocess.run(
                ["sysctl", "-n", "hw.optional.arm64"],
                capture_output=True, text=True, check=True,
            )
            if result.stdout.strip() == "1":
                return "arm64"
        except (subprocess.CalledProcessError, OSError):
            pass
    return platform.machine()


def start_colima(cpu, memory):
    print("⏳ Starting colima...")
    arch = get_hardware_arch()

    if arch == "arm64":
        arch = "aarch64"
    elif arch != "x86_64":
        print("❌ Unsupported architecture: " + arch)
        sys.exit(1)

    subprocess.run(
        [
            "colima",
            "start",
            "--kubernetes",
            # Uncomment the following line if you want to use the MacOS VM framework
            # instead of qemu.
            # "--vm-type=vz",
            # "--vz-rosetta",
            # If using the MacOS VM framework, the following line will ignore IPv6
            # as IPv6 is problematic on some networks.
            # See https://github.com/abiosoft/colima/issues/648
            # "--dns=192.168.5.3",
            "--cpu",
            str(cpu),
            "--memory",
            str(memory),
            # set the current docker/kubernetes context
            "--activate",
            "--arch",
            arch,
            "simpipe",
        ],
        check=True,
    )


def main():
    parser = argparse.ArgumentParser(
        description="Start SIM-PIPE on your local machine."
    )

    parser.add_argument(
        "--cpu", type=int, help="Number of CPU cores (mac only).", default=4
    )
    parser.add_argument(
        "--memory", type=int, help="Amount of memory in GB (mac only).", default=6
    )

    args = parser.parse_args()

    install_main()

    if platform.system() == "Darwin":
        start_colima(cpu=args.cpu, memory=args.memory)

    env, _ = ensure_kubeconfig_env()

    # Check if we can read the Kubernetes config file via kubectl
    try:
        subprocess.run(
            ["kubectl", "config", "view"], check=True, capture_output=True, env=env
        )
    except subprocess.CalledProcessError:
        print("❌ Unable to read Kubernetes config file using kubectl.")
        print("This may be due to permissions or a missing/invalid KUBECONFIG.")
        print("Set KUBECONFIG to a valid kubeconfig and re-run.")
        sys.exit(1)

    nb_tentatives = 0
    while not check_cluster_status(silent=True):
        print("😴 Waiting for Kubernetes cluster to be ready...")
        nb_tentatives += 1
        if nb_tentatives > 8:
            if not check_cluster_status(silent=False):
                sys.exit(1)
        time.sleep(5)
    print("🎉 the kubernetes cluster is ready.")

    install_or_upgrade_simpipe()

    nb_tentatives = 0
    while not check_simpipe_pods_health(silent=True):
        print("😴 Waiting for simpipe pods to be ready...")
        nb_tentatives += 1
        if nb_tentatives > 8:
            if not check_simpipe_pods_health(silent=False):
                sys.exit(1)
        time.sleep(5)

    print("🚀 simpipe is ready.")


if __name__ == "__main__":
    main()
