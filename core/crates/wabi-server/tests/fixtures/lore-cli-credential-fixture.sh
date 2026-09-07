#!/bin/sh
# Protocol fixture ONLY, not a Lore implementation. The service does real
# working-tree I/O; this acknowledges only the CLI operations in the test.
if [ "$1" = "--offline" ] && [ "$2" = "--local" ]; then shift 2; fi
case "$1:$2" in
    repository:create|stage:*|status:--scan) exit 0 ;;
    commit:*)
        printf 'Revision  : 1\nSignature : abcdef0123456789abcdef0123456789\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\n    Credential contract fixture\nCommit succeeded\n'
        ;;
    *) printf 'Unexpected fixture command\n' >&2; exit 1 ;;
esac
