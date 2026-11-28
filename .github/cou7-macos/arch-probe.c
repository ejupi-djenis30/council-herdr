#include <libproc.h>
#include <sys/proc_info.h>
#include <mach/machine.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  char expected[PATH_MAX], actual[PROC_PIDPATHINFO_MAXSIZE], canonical[PATH_MAX];
  if (!realpath(argv[1], expected)) return 3;
  pid_t pid = (pid_t)strtol(argv[2], NULL, 10);
  int length = proc_pidpath(pid, actual, sizeof(actual));
  if (length <= 0 || !realpath(actual, canonical) || strcmp(expected, canonical)) return 4;
  struct proc_archinfo info = {0};
  int n = proc_pidinfo(pid, PROC_PIDARCHINFO, 0, &info, sizeof(info));
  if (n != sizeof(info)) return 5;
  printf("{\"pathMatchesOwnedBinary\":true,\"cpuType\":%d,\"cpuSubtype\":%d,\"arm64\":%s,\"posixSession\":%d}\n",
    info.p_cputype, info.p_cpusubtype, info.p_cputype == CPU_TYPE_ARM64 ? "true" : "false", getsid(pid));
  return 0;
}
