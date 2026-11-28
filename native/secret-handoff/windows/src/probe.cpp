#if !defined(_WIN32) || !defined(_M_ARM64)
#error This feasibility probe must be compiled as native Windows ARM64.
#endif

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <cstdio>

// Inert feasibility probe: no enrollment, IPC, secrets, service or UI.
// It deliberately accepts no arguments and never enables a capability.
int main(int argc, char**) {
  if (argc != 1) {
    std::fputs("{\"schema\":\"council.synthetic-native-probe/v1\",\"status\":\"invalid_input\",\"available\":false}\n", stdout);
    return 2;
  }

  using IsWow64Process2Fn = BOOL(WINAPI*)(HANDLE, USHORT*, USHORT*);
  const HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
  const auto probe = kernel ? reinterpret_cast<IsWow64Process2Fn>(GetProcAddress(kernel, "IsWow64Process2")) : nullptr;
  USHORT process_machine = 0;
  USHORT native_machine = 0;
  const bool known = probe && probe(GetCurrentProcess(), &process_machine, &native_machine);
  const char* status = !known ? "unverifiable" :
    (native_machine == IMAGE_FILE_MACHINE_ARM64 && process_machine == IMAGE_FILE_MACHINE_UNKNOWN) ? "supported" : "unsupported";
  std::printf("{\"schema\":\"council.synthetic-native-probe/v1\",\"status\":\"%s\",\"available\":false}\n", status);
  return 0;
}
