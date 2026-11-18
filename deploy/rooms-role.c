#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static const uint64_t read_tree = LANDLOCK_ACCESS_FS_READ_FILE |
    LANDLOCK_ACCESS_FS_READ_DIR;
static const uint64_t run_tree = LANDLOCK_ACCESS_FS_READ_FILE |
    LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
static const uint64_t write_tree = LANDLOCK_ACCESS_FS_READ_FILE |
    LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_WRITE_FILE |
    LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
    LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_REFER;

static void fail(const char *operation)
{
    perror(operation);
    exit(1);
}

static void allow_path(int ruleset, const char *path, uint64_t access)
{
    int parent = open(path, O_PATH | O_CLOEXEC);
    if (parent < 0) {
        if (errno == ENOENT)
            return;
        fail(path);
    }
    struct stat info;
    if (fstat(parent, &info) < 0)
        fail(path);
    if (!S_ISDIR(info.st_mode))
        access &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
            LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
    const struct landlock_path_beneath_attr rule = {
        .parent_fd = parent, .allowed_access = access,
    };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0)
        fail(path);
    close(parent);
}

int main(int argc, char **argv)
{
    const char *name = strrchr(argv[0], '/');
    name = name ? name + 1 : argv[0];
    const int ffmpeg = strcmp(name, "ffmpeg") == 0;
    const char *role = ffmpeg ? "relay" : (argc >= 3 ? argv[1] : "");
    const int api = strcmp(role, "api") == 0;
    const int media = strcmp(role, "media") == 0;
    const int gateway = strcmp(role, "gateway") == 0;
    const int relay = strcmp(role, "relay") == 0;
    const char *scratch = getenv(ffmpeg ? "ROOMS_RELAY_TMP" : "TMPDIR");
    if (!api && !media && !gateway && !relay) {
        fputs("Usage: rooms-role api|gateway|media|relay /path/to/program [args...]\n", stderr);
        return 1;
    }
    if (syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION) < 3) {
        fputs("Rooms requires Linux Landlock ABI 3 or newer and a container seccomp profile that allows it.\n", stderr);
        return 1;
    }
    const struct landlock_ruleset_attr attributes = {
        .handled_access_fs = write_tree | LANDLOCK_ACCESS_FS_EXECUTE |
            LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_SOCK |
            LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
            LANDLOCK_ACCESS_FS_MAKE_SYM,
    };
    int ruleset = syscall(SYS_landlock_create_ruleset, &attributes,
        sizeof(attributes.handled_access_fs), 0);
    if (ruleset < 0)
        fail("landlock_create_ruleset");

    allow_path(ruleset, "/usr", run_tree);
    allow_path(ruleset, "/lib", run_tree);
    allow_path(ruleset, "/bin", run_tree);
    allow_path(ruleset, "/sbin", run_tree);
    allow_path(ruleset, "/etc", read_tree);
    allow_path(ruleset, "/proc", read_tree);
    allow_path(ruleset, "/sys", read_tree);
    allow_path(ruleset, "/dev/null", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE);
    allow_path(ruleset, "/dev/zero", LANDLOCK_ACCESS_FS_READ_FILE);
    allow_path(ruleset, "/dev/random", LANDLOCK_ACCESS_FS_READ_FILE);
    allow_path(ruleset, "/dev/urandom", LANDLOCK_ACCESS_FS_READ_FILE);

    if (api) {
        allow_path(ruleset, "/app", read_tree);
        allow_path(ruleset, "/data", write_tree);
        allow_path(ruleset, "/watch-data", write_tree);
    }
    if (gateway) {
        allow_path(ruleset, "/srv/www", read_tree);
        allow_path(ruleset, "/srv/desktop-downloads", read_tree);
    }
    if (media)
        allow_path(ruleset, "/tls", read_tree);
    if (scratch && strncmp(scratch, "/tmp/rooms-", 11) == 0)
        allow_path(ruleset, scratch, write_tree);
    const char *relay_scratch = getenv("ROOMS_RELAY_TMP");
    if (media && relay_scratch && strncmp(relay_scratch, "/tmp/rooms-relay-", 17) == 0)
        allow_path(ruleset, relay_scratch, write_tree);

    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0)
        fail("PR_SET_NO_NEW_PRIVS");
    if (syscall(SYS_landlock_restrict_self, ruleset, 0) < 0)
        fail("landlock_restrict_self");
    close(ruleset);

    if (ffmpeg) {
        if (!scratch || setenv("TMPDIR", scratch, 1) < 0)
            fail("TMPDIR");
        execv("/usr/bin/ffmpeg", argv);
    } else {
        execv(argv[2], argv + 2);
    }
    fail("execv");
}
