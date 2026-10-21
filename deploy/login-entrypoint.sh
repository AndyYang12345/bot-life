#!/bin/bash
# Only this process and its QQ children receive the login credential. Never echo
# it or place it in command arguments, Docker Config.Env or Compose output.
set -eu
secret_file=${NAPCAT_QQ_PASSWORD_FILE:-/run/secrets/napcat-qq-password-md5}
if [ ! -f "$secret_file" ] || [ ! -r "$secret_file" ]; then
    echo 'QQ password fallback: private credential file is unavailable.' >&2
    exit 78
fi
if [ "$(wc -c < "$secret_file")" -gt 64 ]; then
    echo 'QQ password fallback: invalid credential format.' >&2
    exit 78
fi
password_md5=$(cat -- "$secret_file")
if [[ ! "$password_md5" =~ ^[a-fA-F0-9]{32}$ ]]; then
    echo 'QQ password fallback: invalid credential format.' >&2
    exit 78
fi
if [ -z "${ACCOUNT:-}" ]; then
    echo 'QQ password fallback: configure the dedicated account first.' >&2
    exit 78
fi
export NAPCAT_QUICK_PASSWORD_MD5="$password_md5"
# Internal Worker restarts do not retain -q. Preserve the same explicit account
# for the upstream WebUI fallback path, without depending on a UI setting.
export NAPCAT_QUICK_ACCOUNT="$ACCOUNT"
unset NAPCAT_QUICK_PASSWORD password_md5
echo 'QQ password fallback: enabled; verification may still require the owner.'
exec "$@"
