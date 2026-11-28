# Windows ARM64 feasibility package

This standalone, explicitly built package is an inert feasibility probe. It is not installed by Council and has no enrollment, broker, dispatch, reveal or real-value path. Do not treat it as a security boundary. The native probe checks only the process and native machine architecture; the Node preflight checks the package's internal consistency and reports protected prerequisites as unverified. Availability is always disabled. A digest stored beside the files is not a signature and does not establish provenance or a protected installation.

With the Microsoft ARM64 toolchain configured, CMake 3.24 or later, MSVC 19.44.35228.0, and Windows SDK 10.0.26100.0:

```powershell
cmake -S native/secret-handoff/windows -B <new-build-dir> -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build <new-build-dir>
node native/secret-handoff/windows/tools/package.mjs <new-build-dir>/council-handoff-probe.exe <new-build-dir>/build-info.json <new-package-dir>
node <new-package-dir>/preflight.mjs
<new-package-dir>/council-handoff-probe.exe
```

The package destination must not already exist. `manifest.sha256` is the SHA-256 of the exact bytes of `manifest.json`; the manifest records the size and SHA-256 of both included artifacts and the specified toolchain. The preflight does not execute the executable or read account identities, environment secrets, security descriptors, process state or configuration. Failed or inaccessible files produce fixed codes without paths or raw errors. No successful preflight enables the feature.

The checked-in package was built on Windows ARM64 with MSVC 19.44.35228.0 and SDK 10.0.26100.0. CMake generated its build metadata; the packager checks that metadata and the PE machine type. This records the build invocation, not an independently attested toolchain. Protected installation, isolated principals, managed launch, operator isolation, custody, IPC and fixed routing remain unverified pending the designated test bench. T002 as a whole and the later native security acceptance cases remain open.
