#!/bin/sh
# Starts throwaway SFTP, FTP, and FTPS servers on this machine for deploy.rs's ignored integration tests:
#
#   sh scripts/deploy-test-servers.sh <folder>
#   TUSK_DEPLOY_TEST=<folder> cargo test --manifest-path src-tauri/Cargo.toml --lib deploy -- --ignored
#
# SFTP is the system's OpenSSH (sshd on port 2222, run as you, with keys made in <folder>). FTP (port 2121) and
# explicit FTPS (port 2990, with a self-signed certificate) are pyftpdlib in a virtual environment in <folder>,
# with user `tusk` and password `tusk`. All serve <folder>/www. Stop them with `kill $(cat <folder>/*.pid)`.
set -e
mkdir -p "${1:?Usage: deploy-test-servers.sh <folder>}"
dir=$(cd "$1" && pwd)
mkdir -p "$dir/www" "$dir/sshd"
cd "$dir/sshd"
[ -f host_key ] || ssh-keygen -q -t ed25519 -N '' -f host_key
[ -f client_key ] || ssh-keygen -q -t ed25519 -N '' -f client_key
[ -f client_key_pw ] || ssh-keygen -q -t ed25519 -N 'secret phrase' -f client_key_pw
cat client_key.pub client_key_pw.pub > authorized_keys
cat > sshd_config <<EOF
Port 2222
ListenAddress 127.0.0.1
HostKey $dir/sshd/host_key
AuthorizedKeysFile $dir/sshd/authorized_keys
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
PidFile $dir/sshd.pid
Subsystem sftp internal-sftp
EOF
"$(command -v sshd || echo /usr/sbin/sshd)" -f "$dir/sshd/sshd_config"

cd "$dir"
[ -d venv ] || { python3 -m venv venv && venv/bin/pip -q install pyftpdlib pyopenssl; }
[ -f ftps.pem ] || openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj /CN=localhost -keyout ftps.pem -out ftps.pem 2>/dev/null
cat > ftp.py <<'EOF'
import sys
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer
folder, tls = sys.argv[1], sys.argv[2] == "1"
auth = DummyAuthorizer()
auth.add_user("tusk", "tusk", folder + "/www", perm="elradfmwMT")
handler = TLS_FTPHandler if tls else FTPHandler
if tls:
    handler.certfile = folder + "/ftps.pem"
    handler.tls_control_required = handler.tls_data_required = True
handler.authorizer = auth
FTPServer(("127.0.0.1", 2990 if tls else 2121), handler).serve_forever()
EOF
for tls in 0 1; do
  venv/bin/python ftp.py "$dir" "$tls" > "ftp$tls.log" 2>&1 &
  echo $! > "ftp$tls.pid"
done
echo "SFTP on 127.0.0.1:2222 (key $dir/sshd/client_key), FTP on 2121, explicit FTPS on 2990 (tusk/tusk), serving $dir/www"
