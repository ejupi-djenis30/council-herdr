#include <libproc.h>
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
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
  struct kinfo_proc info = {0};
  size_t n = sizeof(info);
  int mib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  if (sysctl(mib, 4, &info, &n, NULL, 0) != 0 || n != sizeof(info)) return 5;
#ifdef P_TRANSLATED
  const char *translated = (info.kp_proc.p_flag & P_TRANSLATED) ? "true" : "false";
#else
  const char *translated = "null";
#endif
  printf("{\"pathMatchesOwnedBinary\":true,\"translated\":%s,\"posixSession\":%d,\"sameUid\":%s}\n", translated, getsid(pid),
    info.kp_eproc.e_ucred.cr_uid == getuid() ? "true" : "false");
  return 0;
}
